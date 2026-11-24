using System;
using System.IO;
using Newtonsoft.Json;
using revit_mcp_plugin.Utils;

namespace revit_mcp_plugin.Configuration
{
    /// <summary>
    /// Security switches for the MCP socket, kept in Commands\security.json.
    /// This is a separate file from commandRegistry.json so the command-set settings page
    /// cannot switch code execution back on when it rewrites the registry.
    /// </summary>
    public class SecuritySettings
    {
        public const string FileName = "security.json";

        /// <summary>
        /// Allow send_code_to_revit (arbitrary C# compiled and run inside Revit). Off by default.
        /// </summary>
        [JsonProperty("allowCodeExecution")]
        public bool AllowCodeExecution { get; set; } = false;

        [JsonProperty("_comment")]
        public string Comment { get; set; } =
            "Set allowCodeExecution to true only if you trust every MCP client connected to this Revit session. Restart the MCP service after changing it.";

        public static string GetFilePath()
        {
            return Path.Combine(PathManager.GetCommandsDirectoryPath(), FileName);
        }

        /// <summary>
        /// Load security.json, creating it with safe defaults if missing.
        /// Any read or parse error falls back to the safe defaults.
        /// </summary>
        public static SecuritySettings Load(Action<string> logWarning = null)
        {
            string path = GetFilePath();
            try
            {
                if (!File.Exists(path))
                {
                    var defaults = new SecuritySettings();
                    File.WriteAllText(path, JsonConvert.SerializeObject(defaults, Formatting.Indented));
                    return defaults;
                }

                var loaded = JsonConvert.DeserializeObject<SecuritySettings>(File.ReadAllText(path));
                return loaded ?? new SecuritySettings();
            }
            catch (Exception ex)
            {
                logWarning?.Invoke("Could not read " + path + " (" + ex.Message + "); using safe defaults.");
                return new SecuritySettings();
            }
        }
    }
}
