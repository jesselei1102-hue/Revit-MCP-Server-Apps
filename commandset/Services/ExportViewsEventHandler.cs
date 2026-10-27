using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Utils;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace RevitMCPCommandSet.Services
{
    public class ExportViewsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        public JObject Parameters { get; private set; }
        public object Result { get; private set; }

        public void SetParameters(JObject parameters)
        {
            Parameters = parameters ?? new JObject();
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000) => _resetEvent.WaitOne(timeoutMilliseconds);

        public void Execute(UIApplication app)
        {
            try
            {
                var uiDoc = app.ActiveUIDocument;
                var doc = uiDoc.Document;
                var exportMode = Parameters.Value<string>("exportMode") ?? "ByViewList";
                var fileFormat = (Parameters.Value<string>("fileFormat") ?? "PNG").ToUpperInvariant();
                var directoryPath = Parameters.Value<string>("directoryPath");
                var supportedFormats = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                    { "PNG", "JPG", "JPEG", "BMP", "TIFF", "TIF", "CSV", "PDF" };
                if (!supportedFormats.Contains(fileFormat))
                    throw new ArgumentException($"Invalid file format specified: '{fileFormat}'");
                if (fileFormat == "JPEG")
                    fileFormat = "JPG";
                if (fileFormat == "TIF")
                    fileFormat = "TIFF";

                var supportedModes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                    { "ByViewList", "CurrentView", "VisibleRegion" };
                if (!supportedModes.Contains(exportMode))
                    throw new ArgumentException($"Invalid export mode specified: '{exportMode}'");
                if (string.Equals(exportMode, "VisibleRegion", StringComparison.OrdinalIgnoreCase)
                    && (fileFormat == "PDF" || fileFormat == "CSV"))
                    throw new ArgumentException($"'VisibleRegion' mode is not supported for {fileFormat}");

                if (string.IsNullOrWhiteSpace(directoryPath))
                    directoryPath = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                Directory.CreateDirectory(directoryPath);

                var exported = new List<string>();
                var skipped = new List<string>();
                var views = ResolveViews(uiDoc, doc, exportMode, Parameters["viewIds"]?.ToObject<List<long>>());

                if (fileFormat == "CSV")
                {
                    foreach (var view in views)
                    {
                        if (view is ViewSchedule schedule)
                        {
                            var fileName = Sanitize($"{schedule.Name}_{schedule.Id.GetIntValue()}.csv");
                            schedule.Export(directoryPath, fileName, new ViewScheduleExportOptions());
                            exported.Add(Path.Combine(directoryPath, fileName));
                        }
                        else
                        {
                            skipped.Add($"{view.Name}: CSV is only supported for schedule views");
                        }
                    }
                }
                else if (fileFormat == "PDF")
                {
                    var printable = views.Where(PublicMcpUtils.IsPrintableView).ToList();
                    foreach (var view in views.Except(printable))
                        skipped.Add($"{view.Name}: cannot be printed/exported to PDF.");
                    if (printable.Count == 0)
                        throw new Exception("No valid printable views found in the provided list.");

                    if (printable.Count > 0)
                    {
#if REVIT2022_OR_GREATER
                        var options = new PDFExportOptions
                        {
                            Combine = false,
                            FileName = "View"
                        };
                        var viewIds = printable.Select(v => v.Id).ToList();
                        if (doc.Export(directoryPath, viewIds, options))
                        {
                            var pdfs = Directory.GetFiles(directoryPath, "*.pdf")
                                .OrderByDescending(File.GetLastWriteTimeUtc)
                                .Take(printable.Count)
                                .ToList();
                            if (pdfs.Count == 0)
                                throw new Exception($"PDF export completed but file was not found at expected location: {directoryPath}");
                            exported.AddRange(pdfs);
                        }
                        else
                        {
                            throw new Exception("PDF export failed - Revit API returned false. ");
                        }
#else
                        throw new Exception("PDF export requires Revit 2022 or newer.");
#endif
                    }
                }
                else
                {
                    var imageType = fileFormat switch
                    {
                        "JPG" => ImageFileType.JPEGMedium,
                        "BMP" => ImageFileType.BMP,
                        "TIFF" => ImageFileType.TIFF,
                        _ => ImageFileType.PNG
                    };
                    var extension = fileFormat switch
                    {
                        "JPG" => ".jpg",
                        "BMP" => ".bmp",
                        "TIFF" => ".tif",
                        _ => ".png"
                    };

                    if (string.Equals(exportMode, "VisibleRegion", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(exportMode, "CurrentView", StringComparison.OrdinalIgnoreCase))
                    {
                        var view = doc.ActiveView;
                        var filePath = Path.Combine(directoryPath, Sanitize($"{view.Name}_{view.Id.GetIntValue()}"));
                        var options = CreateImageOptions(imageType);
                        options.FilePath = filePath;
                        options.ExportRange = string.Equals(exportMode, "VisibleRegion", StringComparison.OrdinalIgnoreCase)
                            ? ExportRange.VisibleRegionOfCurrentView
                            : ExportRange.CurrentView;
                        var before = SnapshotExportDirectory(directoryPath, extension);
                        doc.ExportImage(options);
                        var files = FindExportedFiles(doc, directoryPath, filePath, view.Id, extension, before).ToList();
                        if (files.Count == 0)
                            throw new Exception("Failed to export: file was not created");
                        exported.AddRange(files);
                    }
                    else
                    {
                    var printable = views.Where(v => v is not ViewSchedule && PublicMcpUtils.IsPrintableView(v)).ToList();
                    foreach (var view in views.Except(printable))
                        skipped.Add($"{view.Name}: Not a printable view. ");
                    if (printable.Count == 0)
                        throw new Exception("No valid printable views found in the provided list.");

                        foreach (var view in printable)
                        {
                            try
                            {
                                var filePath = Path.Combine(directoryPath, Sanitize($"{view.Name}_{view.Id.GetIntValue()}"));
                                var options = CreateImageOptions(imageType);
                                options.FilePath = filePath;
                                options.ExportRange = ExportRange.SetOfViews;
                                options.SetViewsAndSheets(new List<ElementId> { view.Id });
                                var before = SnapshotExportDirectory(directoryPath, extension);
                                doc.ExportImage(options);
                                var files = FindExportedFiles(doc, directoryPath, filePath, view.Id, extension, before).ToList();
                                if (files.Count == 0)
                                    skipped.Add($"{view.Name}: Failed to export: file was not created");
                                else
                                    exported.AddRange(files);
                            }
                            catch (Exception ex)
                            {
                                skipped.Add($"{view.Name}: {ex.Message}");
                            }
                        }
                    }
                }

                Result = new
                {
                    success = true,
                    directoryPath,
                    fileFormat,
                    exportedFiles = exported.Distinct().ToList(),
                    skipped
                };
            }
            catch (Exception ex)
            {
                Result = new { success = false, message = ex.Message };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        private static List<View> ResolveViews(UIDocument uiDoc, Document doc, string exportMode, List<long> viewIds)
        {
            if (string.Equals(exportMode, "CurrentView", StringComparison.OrdinalIgnoreCase)
                || string.Equals(exportMode, "VisibleRegion", StringComparison.OrdinalIgnoreCase))
            {
                return new List<View> { doc.ActiveView };
            }

            if (viewIds == null || viewIds.Count == 0)
                throw new ArgumentException("Element Ids array cannot be null or empty for 'ByViewList' mode.");

            var views = new List<View>();
            foreach (var id in viewIds)
            {
                if (doc.GetElement(PublicMcpUtils.Id(id)) is View view)
                    views.Add(view);
                else
                    throw new Exception($"View {id} was not found");
            }
            return views;
        }

        private static ImageExportOptions CreateImageOptions(ImageFileType imageType)
        {
            return new ImageExportOptions
            {
                ZoomType = ZoomFitType.FitToPage,
                PixelSize = 2048,
                ImageResolution = ImageResolution.DPI_150,
                FitDirection = FitDirectionType.Horizontal,
                HLRandWFViewsFileType = imageType,
                ShadowViewsFileType = imageType
            };
        }

        private static Dictionary<string, DateTime> SnapshotExportDirectory(string directory, string extension)
        {
            if (!Directory.Exists(directory))
                return new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

            return Directory.GetFiles(directory)
                .Where(path => path.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
                .ToDictionary(path => path, File.GetLastWriteTimeUtc, StringComparer.OrdinalIgnoreCase);
        }

        private static IEnumerable<string> FindExportedFiles(
            Document doc,
            string directory,
            string filePathWithoutExtension,
            ElementId viewId,
            string extension,
            Dictionary<string, DateTime> before = null)
        {
            var matches = new List<string>();
            try
            {
                var generated = ImageExportOptions.GetFileName(doc, viewId);
                if (!string.IsNullOrWhiteSpace(generated))
                {
                    var generatedPath = Path.Combine(directory, Sanitize(generated));
                    if (!generatedPath.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
                        generatedPath += extension;
                    if (File.Exists(generatedPath))
                        matches.Add(generatedPath);
                }
            }
            catch
            {
                // GetFileName is best-effort; fall back to scanning the folder.
            }

            if (before != null)
            {
                matches.AddRange(Directory.GetFiles(directory)
                    .Where(path =>
                        path.EndsWith(extension, StringComparison.OrdinalIgnoreCase)
                        && (!before.TryGetValue(path, out var previous)
                            || File.GetLastWriteTimeUtc(path) > previous)));
            }

            var name = Path.GetFileName(filePathWithoutExtension);
            matches.AddRange(Directory.GetFiles(directory)
                .Where(path =>
                {
                    var fileName = Path.GetFileNameWithoutExtension(path);
                    return fileName.StartsWith(name, StringComparison.OrdinalIgnoreCase)
                           && path.EndsWith(extension, StringComparison.OrdinalIgnoreCase);
                }));

            if (matches.Count == 0 && File.Exists(filePathWithoutExtension + extension))
                matches.Add(filePathWithoutExtension + extension);

            return matches.Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .Take(5);
        }

        private static string Sanitize(string name)
        {
            foreach (var c in Path.GetInvalidFileNameChars())
                name = name.Replace(c, '_');
            return name;
        }

        public string GetName() => "export_views";
    }
}
