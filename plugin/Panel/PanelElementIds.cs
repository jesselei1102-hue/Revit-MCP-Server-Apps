using Autodesk.Revit.DB;

namespace revit_mcp_plugin.Panel
{
    /// <summary>
    /// ElementId helpers spanning Revit 2020–2027 (Value/long vs IntegerValue/int).
    /// </summary>
    internal static class PanelElementIds
    {
#if REVIT2024_OR_GREATER
        public static long GetValue(ElementId id) => id.Value;

        public static ElementId Create(long id) => new ElementId(id);
#else
        public static long GetValue(ElementId id) => id.IntegerValue;

        public static ElementId Create(long id) => new ElementId((int)id);
#endif
    }
}
