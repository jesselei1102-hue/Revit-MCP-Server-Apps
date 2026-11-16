using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Newtonsoft.Json.Linq;
using RevitMCPMEPCommandSet.Utils;

namespace RevitMCPMEPCommandSet.Services
{
    internal static class MepCurveService
    {
        public static object QueryTypes(Document doc, string command, JObject parameters)
        {
            switch (command)
            {
                case "get_pipe_types":
                    return ListTypes(new FilteredElementCollector(doc).OfClass(typeof(PipeType)), parameters, null);
                case "get_duct_types":
                    return ListTypes(new FilteredElementCollector(doc).OfClass(typeof(DuctType)), parameters, DuctShape);
                case "get_cable_tray_types":
                    return ListTypes(new FilteredElementCollector(doc).OfClass(typeof(CableTrayType)), parameters, null);
                case "get_pipe_system_types":
                    return ListSystemTypes(new FilteredElementCollector(doc).OfClass(typeof(PipingSystemType)), parameters);
                case "get_duct_system_types":
                    return ListSystemTypes(new FilteredElementCollector(doc).OfClass(typeof(MechanicalSystemType)), parameters);
                case "get_pipes":
                    return ListCurves(doc, new FilteredElementCollector(doc).OfClass(typeof(Pipe)).Cast<MEPCurve>(), parameters, "pipe");
                case "get_ducts":
                    return ListCurves(doc, new FilteredElementCollector(doc).OfClass(typeof(Duct)).Cast<MEPCurve>(), parameters, "duct");
                case "get_cable_trays":
                    return ListCurves(doc, new FilteredElementCollector(doc).OfClass(typeof(CableTray)).Cast<MEPCurve>(), parameters, "cable_tray");
                default:
                    throw new InvalidOperationException("Unknown query " + command + ".");
            }
        }

        public static object Create(Document doc, string command, JObject parameters)
        {
            return InTransaction(doc, command, parameters, () =>
            {
                switch (command)
                {
                    case "create_pipe":
                        return Snapshot(CreatePipe(doc, parameters));
                    case "create_duct":
                        return Snapshot(CreateDuct(doc, parameters));
                    case "create_cable_tray":
                        return Snapshot(CreateCableTray(doc, parameters));
                    default:
                        throw new InvalidOperationException("Unknown create command " + command + ".");
                }
            });
        }

        public static object Modify(Document doc, string command, JObject parameters)
        {
            return InTransaction(doc, command, parameters, () =>
            {
                switch (command)
                {
                    case "modify_pipe":
                        return Snapshot(ModifyPipe(doc, parameters));
                    case "modify_duct":
                        return Snapshot(ModifyDuct(doc, parameters));
                    case "modify_cable_tray":
                        return Snapshot(ModifyCableTray(doc, parameters));
                    default:
                        throw new InvalidOperationException("Unknown modify command " + command + ".");
                }
            });
        }

        private static Pipe CreatePipe(Document doc, JObject parameters)
        {
            PipeType pipeType = ResolveType<PipeType>(doc, OptionalTypeId(parameters, "pipeTypeId", "pipe_type_id", "typeId", "type_id"), "pipe");
            PipingSystemType systemType = RequireElement<PipingSystemType>(doc, RequiredId(parameters, "systemTypeId", "system_type_id"), "piping system type");
            Level level = RequireElement<Level>(doc, RequiredId(parameters, "levelId", "level_id"), "level");
            XYZ start = Point(parameters, "start");
            XYZ end = Point(parameters, "end");
            EnsureLength(start, end);
            Pipe pipe = Pipe.Create(doc, systemType.Id, pipeType.Id, level.Id, start, end);
            double? diameter = MepParams.OptionalDouble(parameters, "diameterMm", "diameter_mm");
            if (diameter.HasValue)
                SetDiameter(pipe, diameter.Value, "pipe");
            return pipe;
        }

        private static Duct CreateDuct(Document doc, JObject parameters)
        {
            DuctType ductType = ResolveType<DuctType>(doc, OptionalTypeId(parameters, "ductTypeId", "duct_type_id", "typeId", "type_id"), "duct");
            MechanicalSystemType systemType = RequireElement<MechanicalSystemType>(doc, RequiredId(parameters, "systemTypeId", "system_type_id"), "duct system type");
            Level level = RequireElement<Level>(doc, RequiredId(parameters, "levelId", "level_id"), "level");
            XYZ start = Point(parameters, "start");
            XYZ end = Point(parameters, "end");
            EnsureLength(start, end);
            Duct duct = Duct.Create(doc, systemType.Id, ductType.Id, level.Id, start, end);
            ApplyDuctSize(duct, ductType, parameters, false);
            return duct;
        }

        private static CableTray CreateCableTray(Document doc, JObject parameters)
        {
            CableTrayType trayType = ResolveType<CableTrayType>(doc, OptionalTypeId(parameters, "cableTrayTypeId", "cable_tray_type_id", "typeId", "type_id"), "cable tray");
            Level level = RequireElement<Level>(doc, RequiredId(parameters, "levelId", "level_id"), "level");
            XYZ start = Point(parameters, "start");
            XYZ end = Point(parameters, "end");
            EnsureLength(start, end);
            CableTray tray = CableTray.Create(doc, trayType.Id, start, end, level.Id);
            ApplyRectSize(tray, parameters, BuiltInParameter.RBS_CABLETRAY_WIDTH_PARAM, BuiltInParameter.RBS_CABLETRAY_HEIGHT_PARAM, "cable tray");
            return tray;
        }

        private static Pipe ModifyPipe(Document doc, JObject parameters)
        {
            Pipe pipe = RequireElement<Pipe>(doc, RequiredId(parameters, "elementId", "element_id"), "pipe");
            bool changed = MoveEnds(pipe, parameters);
            long? typeId = OptionalTypeId(parameters, "pipeTypeId", "pipe_type_id", "typeId", "type_id");
            if (typeId.HasValue)
            {
                RequireElement<PipeType>(doc, typeId.Value, "pipe type");
                pipe.ChangeTypeId(MepIds.From(typeId.Value));
                changed = true;
            }
            if (MepParams.Has(parameters, "widthMm", "width_mm", "heightMm", "height_mm"))
                throw new ArgumentException("Pipes are round. Use diameterMm.");
            double? diameter = MepParams.OptionalDouble(parameters, "diameterMm", "diameter_mm");
            if (diameter.HasValue)
            {
                SetDiameter(pipe, diameter.Value, "pipe");
                changed = true;
            }
            if (!changed)
                throw new ArgumentException("Nothing to modify. Pass endpoints, pipeTypeId, or diameterMm.");
            return pipe;
        }

        private static Duct ModifyDuct(Document doc, JObject parameters)
        {
            Duct duct = RequireElement<Duct>(doc, RequiredId(parameters, "elementId", "element_id"), "duct");
            bool changed = MoveEnds(duct, parameters);
            DuctType ductType = doc.GetElement(duct.GetTypeId()) as DuctType;
            long? typeId = OptionalTypeId(parameters, "ductTypeId", "duct_type_id", "typeId", "type_id");
            if (typeId.HasValue)
            {
                ductType = RequireElement<DuctType>(doc, typeId.Value, "duct type");
                duct.ChangeTypeId(ductType.Id);
                changed = true;
            }
            if (ApplyDuctSize(duct, ductType, parameters, true))
                changed = true;
            if (!changed)
                throw new ArgumentException("Nothing to modify. Pass endpoints, ductTypeId, or a size.");
            return duct;
        }

        private static CableTray ModifyCableTray(Document doc, JObject parameters)
        {
            CableTray tray = RequireElement<CableTray>(doc, RequiredId(parameters, "elementId", "element_id"), "cable tray");
            bool changed = MoveEnds(tray, parameters);
            long? typeId = OptionalTypeId(parameters, "cableTrayTypeId", "cable_tray_type_id", "typeId", "type_id");
            if (typeId.HasValue)
            {
                RequireElement<CableTrayType>(doc, typeId.Value, "cable tray type");
                tray.ChangeTypeId(MepIds.From(typeId.Value));
                changed = true;
            }
            if (MepParams.Has(parameters, "diameterMm", "diameter_mm"))
                throw new ArgumentException("Cable trays use widthMm and heightMm.");
            if (ApplyRectSize(tray, parameters, BuiltInParameter.RBS_CABLETRAY_WIDTH_PARAM, BuiltInParameter.RBS_CABLETRAY_HEIGHT_PARAM, "cable tray"))
                changed = true;
            if (!changed)
                throw new ArgumentException("Nothing to modify. Pass endpoints, typeId, widthMm, or heightMm.");
            return tray;
        }

        private static bool ApplyDuctSize(Duct duct, DuctType ductType, JObject parameters, bool modifying)
        {
            bool round = ductType != null && ductType.Shape == ConnectorProfileType.Round;
            bool hasDiameter = MepParams.Has(parameters, "diameterMm", "diameter_mm");
            bool hasRect = MepParams.Has(parameters, "widthMm", "width_mm", "heightMm", "height_mm");
            if (round && hasRect)
                throw new ArgumentException("This duct is round. Use diameterMm.");
            if (!round && hasDiameter)
                throw new ArgumentException("This duct is " + ShapeName(ductType) + ". Use widthMm and heightMm.");
            if (hasDiameter)
            {
                SetDiameter(duct, MepParams.OptionalDouble(parameters, "diameterMm", "diameter_mm").Value, "duct");
                return true;
            }
            return ApplyRectSize(duct, parameters, BuiltInParameter.RBS_CURVE_WIDTH_PARAM, BuiltInParameter.RBS_CURVE_HEIGHT_PARAM, "duct");
        }

        private static bool ApplyRectSize(MEPCurve curve, JObject parameters, BuiltInParameter widthParam, BuiltInParameter heightParam, string label)
        {
            bool changed = false;
            double? width = MepParams.OptionalDouble(parameters, "widthMm", "width_mm");
            double? height = MepParams.OptionalDouble(parameters, "heightMm", "height_mm");
            if (width.HasValue)
            {
                SetLengthParam(curve, widthParam, width.Value, label + " width");
                changed = true;
            }
            if (height.HasValue)
            {
                SetLengthParam(curve, heightParam, height.Value, label + " height");
                changed = true;
            }
            return changed;
        }

        private static object ListTypes(FilteredElementCollector collector, JObject parameters, Func<Element, string> shape)
        {
            int limit = MepParams.Limit(parameters, 500, 2000);
            var items = collector
                .Cast<Element>()
                .OrderBy(element => MepIds.Value(element.Id))
                .Select(element =>
                {
                    var row = new Dictionary<string, object>
                    {
                        ["id"] = MepIds.Value(element.Id),
                        ["name"] = element.Name
                    };
                    if (shape != null)
                        row["shape"] = shape(element);
                    return row;
                })
                .ToList();
            return Page(items, limit);
        }

        private static object ListSystemTypes(FilteredElementCollector collector, JObject parameters)
        {
            string systemClass = MepParams.OptionalString(parameters, "systemClass", "system_class");
            int limit = MepParams.Limit(parameters, 500, 2000);
            var items = new List<Dictionary<string, object>>();
            foreach (Element element in collector.Cast<Element>().OrderBy(element => MepIds.Value(element.Id)))
            {
                string classification = SystemClassification(element);
                if (systemClass != null && !classification.Equals(systemClass, StringComparison.OrdinalIgnoreCase))
                    continue;
                items.Add(new Dictionary<string, object>
                {
                    ["id"] = MepIds.Value(element.Id),
                    ["name"] = element.Name,
                    ["systemClass"] = classification
                });
            }
            return Page(items, limit);
        }

        private static object ListCurves(Document doc, IEnumerable<MEPCurve> curves, JObject parameters, string discipline)
        {
            long? levelId = MepParams.OptionalLong(parameters, "levelId", "level_id");
            long? typeId = OptionalTypeId(parameters, "typeId", "type_id", "pipeTypeId", "pipe_type_id", "ductTypeId", "duct_type_id", "cableTrayTypeId", "cable_tray_type_id");
            long? systemTypeId = MepParams.OptionalLong(parameters, "systemTypeId", "system_type_id");
            double? diameter = MepParams.OptionalDouble(parameters, "diameterMm", "diameter_mm");
            string shape = MepParams.OptionalString(parameters, "shape");
            int limit = MepParams.Limit(parameters, 200, 2000);

            var items = new List<Dictionary<string, object>>();
            foreach (MEPCurve curve in curves.OrderBy(curve => MepIds.Value(curve.Id)))
            {
                Dictionary<string, object> snapshot = Snapshot(curve);
                if (levelId.HasValue && !EqualsId(snapshot, "levelId", levelId.Value))
                    continue;
                if (typeId.HasValue && !EqualsId(snapshot, "typeId", typeId.Value))
                    continue;
                if (systemTypeId.HasValue && !EqualsId(snapshot, "systemTypeId", systemTypeId.Value))
                    continue;
                if (diameter.HasValue && (!snapshot.ContainsKey("diameterMm") || Math.Abs(Convert.ToDouble(snapshot["diameterMm"]) - diameter.Value) > 0.5))
                    continue;
                if (shape != null && discipline == "duct")
                {
                    DuctType ductType = doc.GetElement(curve.GetTypeId()) as DuctType;
                    if (ductType == null || !ShapeName(ductType).Equals(shape, StringComparison.OrdinalIgnoreCase))
                        continue;
                    snapshot["shape"] = ShapeName(ductType);
                }
                items.Add(snapshot);
            }
            return Page(items, limit);
        }

        public static Dictionary<string, object> Snapshot(MEPCurve curve)
        {
            var row = new Dictionary<string, object>
            {
                ["id"] = MepIds.Value(curve.Id),
                ["name"] = curve.Name,
                ["typeId"] = MepIds.Value(curve.GetTypeId()),
                ["category"] = curve.Category?.Name
            };
            Element type = curve.Document.GetElement(curve.GetTypeId());
            if (type != null)
                row["typeName"] = type.Name;

            long levelId = ParamId(curve, BuiltInParameter.RBS_START_LEVEL_PARAM);
            if (levelId > 0)
                row["levelId"] = levelId;
            long systemTypeId = ParamId(curve, BuiltInParameter.RBS_PIPING_SYSTEM_TYPE_PARAM);
            if (systemTypeId < 0)
                systemTypeId = ParamId(curve, BuiltInParameter.RBS_DUCT_SYSTEM_TYPE_PARAM);
            if (systemTypeId > 0)
                row["systemTypeId"] = systemTypeId;

            Curve location = MepCurveGeometry.LocationCurve(curve);
            if (location != null)
            {
                row["start"] = Xyz(location.GetEndPoint(0));
                row["end"] = Xyz(location.GetEndPoint(1));
                row["lengthMm"] = Math.Round(MepUnits.FtToMm(location.Length), 3);
            }

            double? diameter = ParamMm(curve, BuiltInParameter.RBS_PIPE_DIAMETER_PARAM) ?? ParamMm(curve, BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
            double? width = ParamMm(curve, BuiltInParameter.RBS_CABLETRAY_WIDTH_PARAM) ?? ParamMm(curve, BuiltInParameter.RBS_CURVE_WIDTH_PARAM);
            double? height = ParamMm(curve, BuiltInParameter.RBS_CABLETRAY_HEIGHT_PARAM) ?? ParamMm(curve, BuiltInParameter.RBS_CURVE_HEIGHT_PARAM);
            if (diameter.HasValue && diameter.Value > 0)
                row["diameterMm"] = Math.Round(diameter.Value, 3);
            if (width.HasValue && width.Value > 0)
                row["widthMm"] = Math.Round(width.Value, 3);
            if (height.HasValue && height.Value > 0)
                row["heightMm"] = Math.Round(height.Value, 3);
            return row;
        }

        public static MepSize ReadSize(MEPCurve curve)
        {
            return new MepSize
            {
                DiameterMm = ParamMm(curve, BuiltInParameter.RBS_PIPE_DIAMETER_PARAM) ?? ParamMm(curve, BuiltInParameter.RBS_CURVE_DIAMETER_PARAM) ?? 0,
                WidthMm = ParamMm(curve, BuiltInParameter.RBS_CABLETRAY_WIDTH_PARAM) ?? ParamMm(curve, BuiltInParameter.RBS_CURVE_WIDTH_PARAM) ?? 0,
                HeightMm = ParamMm(curve, BuiltInParameter.RBS_CABLETRAY_HEIGHT_PARAM) ?? ParamMm(curve, BuiltInParameter.RBS_CURVE_HEIGHT_PARAM) ?? 0
            };
        }

        public static object InTransaction(Document doc, string name, JObject parameters, Func<object> action)
        {
            bool dryRun = MepParams.Bool(parameters, false, "dryRun", "dry_run");
            using (var transaction = new Transaction(doc, "MCP " + name))
            {
                transaction.Start();
                FailureHandlingOptions options = transaction.GetFailureHandlingOptions();
                options.SetFailuresPreprocessor(new MepWarningSwallower());
                transaction.SetFailureHandlingOptions(options);
                object result = action();
                if (result is Dictionary<string, object> row)
                    row["dryRun"] = dryRun;
                if (dryRun)
                    transaction.RollBack();
                else
                    transaction.Commit();
                return result;
            }
        }

        private static object Page(List<Dictionary<string, object>> items, int limit)
        {
            return new Dictionary<string, object>
            {
                ["total"] = items.Count,
                ["count"] = Math.Min(limit, items.Count),
                ["items"] = items.Take(limit).ToList()
            };
        }

        private static bool MoveEnds(MEPCurve curve, JObject parameters)
        {
            bool hasStart = MepParams.Has(parameters, "startX", "start_x");
            bool hasEnd = MepParams.Has(parameters, "endX", "end_x");
            if (!hasStart && !hasEnd)
                return false;
            Curve location = MepCurveGeometry.LocationCurve(curve);
            if (location == null)
                throw new ArgumentException("Element has no location curve.");
            XYZ start = hasStart ? Point(parameters, "start") : location.GetEndPoint(0);
            XYZ end = hasEnd ? Point(parameters, "end") : location.GetEndPoint(1);
            EnsureLength(start, end);
            ((LocationCurve)curve.Location).Curve = Line.CreateBound(start, end);
            return true;
        }

        private static XYZ Point(JObject parameters, string prefix)
        {
            string x = prefix + "X";
            string y = prefix + "Y";
            string z = prefix + "Z";
            string xSnake = prefix + "_x";
            string ySnake = prefix + "_y";
            string zSnake = prefix + "_z";
            bool any = MepParams.Has(parameters, x, xSnake) || MepParams.Has(parameters, y, ySnake) || MepParams.Has(parameters, z, zSnake);
            if (!any)
                throw new ArgumentException("Missing " + prefix + " point.");
            if (!MepParams.Has(parameters, x, xSnake) || !MepParams.Has(parameters, y, ySnake) || !MepParams.Has(parameters, z, zSnake))
                throw new ArgumentException(prefix + "X, " + prefix + "Y, and " + prefix + "Z must be supplied together. Values are millimeters.");
            return new XYZ(
                MepUnits.MmToFt(MepParams.RequiredDouble(parameters, x, x, xSnake)),
                MepUnits.MmToFt(MepParams.RequiredDouble(parameters, y, y, ySnake)),
                MepUnits.MmToFt(MepParams.RequiredDouble(parameters, z, z, zSnake)));
        }

        private static void EnsureLength(XYZ start, XYZ end)
        {
            if (start.DistanceTo(end) < MepUnits.MinSegmentLengthFeet)
                throw new ArgumentException("Start and end are closer than 0.1 inch (2.54 mm).");
        }

        private static void SetDiameter(MEPCurve curve, double millimeters, string label)
        {
            if (millimeters <= 0)
                throw new ArgumentException(label + " diameterMm must be greater than 0.");
            BuiltInParameter parameter = curve is Pipe
                ? BuiltInParameter.RBS_PIPE_DIAMETER_PARAM
                : BuiltInParameter.RBS_CURVE_DIAMETER_PARAM;
            SetLengthParam(curve, parameter, millimeters, label + " diameter");
        }

        private static void SetLengthParam(MEPCurve curve, BuiltInParameter parameter, double millimeters, string label)
        {
            if (millimeters <= 0)
                throw new ArgumentException(label + " must be greater than 0.");
            Parameter value = curve.get_Parameter(parameter);
            if (value == null || value.IsReadOnly || !value.Set(MepUnits.MmToFt(millimeters)))
                throw new ArgumentException("Could not set " + label + ".");
        }

        private static T ResolveType<T>(Document doc, long? id, string label) where T : Element
        {
            if (id.HasValue)
                return RequireElement<T>(doc, id.Value, label + " type");
            T first = new FilteredElementCollector(doc).OfClass(typeof(T)).Cast<T>().FirstOrDefault();
            if (first == null)
                throw new InvalidOperationException("No " + label + " type is loaded in this document.");
            return first;
        }

        public static T RequireElement<T>(Document doc, long id, string label) where T : Element
        {
            if (id <= 0)
                throw new ArgumentException(label + " id must be a positive element id.");
            if (!(doc.GetElement(MepIds.From(id)) is T element))
                throw new ArgumentException("Element " + id + " is not a " + label + ".");
            return element;
        }

        public static MEPCurve RequireCurve(Document doc, long id, string discipline)
        {
            MEPCurve curve = RequireElement<MEPCurve>(doc, id, discipline);
            BuiltInCategory category = CategoryFor(discipline);
            if (!MepIds.IsCategory(curve, category))
                throw new ArgumentException("Element " + id + " is not a " + discipline.Replace('_', ' ') + ".");
            return curve;
        }

        public static BuiltInCategory CategoryFor(string discipline)
        {
            switch (discipline)
            {
                case "pipe": return BuiltInCategory.OST_PipeCurves;
                case "duct": return BuiltInCategory.OST_DuctCurves;
                case "cable_tray": return BuiltInCategory.OST_CableTray;
                default: throw new ArgumentException("class must be pipe, duct, or cable_tray.");
            }
        }

        private static long RequiredId(JObject parameters, params string[] names)
        {
            return MepParams.RequiredLong(parameters, names[0], names);
        }

        private static long? OptionalTypeId(JObject parameters, params string[] names)
        {
            return MepParams.OptionalLong(parameters, names);
        }

        private static string DuctShape(Element element)
        {
            return ShapeName(element as DuctType);
        }

        private static string ShapeName(DuctType ductType)
        {
            if (ductType == null)
                return "unknown";
            return ductType.Shape.ToString().ToLowerInvariant();
        }

        private static string SystemClassification(Element element)
        {
            if (element is PipingSystemType piping)
                return piping.SystemClassification.ToString();
            if (element is MechanicalSystemType mechanical)
                return mechanical.SystemClassification.ToString();
            return "";
        }

        private static long ParamId(Element element, BuiltInParameter parameter)
        {
            Parameter value = element.get_Parameter(parameter);
            if (value == null)
                return -1;
            return MepIds.Value(value.AsElementId());
        }

        private static double? ParamMm(Element element, BuiltInParameter parameter)
        {
            Parameter value = element.get_Parameter(parameter);
            if (value == null || value.StorageType != StorageType.Double)
                return null;
            return MepUnits.FtToMm(value.AsDouble());
        }

        private static Dictionary<string, object> Xyz(XYZ point)
        {
            return new Dictionary<string, object>
            {
                ["x"] = Math.Round(MepUnits.FtToMm(point.X), 3),
                ["y"] = Math.Round(MepUnits.FtToMm(point.Y), 3),
                ["z"] = Math.Round(MepUnits.FtToMm(point.Z), 3)
            };
        }

        private static bool EqualsId(Dictionary<string, object> row, string key, long id)
        {
            return row.ContainsKey(key) && Convert.ToInt64(row[key]) == id;
        }
    }

    internal struct MepSize
    {
        public double DiameterMm;
        public double WidthMm;
        public double HeightMm;

        public bool DiffersFrom(MepSize other)
        {
            return Math.Abs(DiameterMm - other.DiameterMm) >= 0.01
                || Math.Abs(WidthMm - other.WidthMm) >= 0.01
                || Math.Abs(HeightMm - other.HeightMm) >= 0.01;
        }
    }

    internal sealed class MepWarningSwallower : IFailuresPreprocessor
    {
        public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
        {
            foreach (FailureMessageAccessor failure in accessor.GetFailureMessages())
            {
                if (failure.GetSeverity() == FailureSeverity.Warning)
                    accessor.DeleteWarning(failure);
            }
            return FailureProcessingResult.Continue;
        }
    }
}
