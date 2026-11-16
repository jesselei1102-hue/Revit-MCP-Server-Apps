using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPMEPCommandSet.Services
{
    internal static class MepOperations
    {
        public static object Run(Document doc, string command, JObject parameters)
        {
            if (command.StartsWith("get_", StringComparison.Ordinal))
                return MepCurveService.QueryTypes(doc, command, parameters);
            if (command.StartsWith("create_", StringComparison.Ordinal) && !MepFittingService.IsFittingCommand(command))
                return MepCurveService.Create(doc, command, parameters);
            if (command.StartsWith("modify_", StringComparison.Ordinal))
                return MepCurveService.Modify(doc, command, parameters);
            if (MepFittingService.IsFittingCommand(command))
                return MepFittingService.Create(doc, command, parameters);
            throw new InvalidOperationException("Unknown MEP command " + command + ".");
        }
    }
}
