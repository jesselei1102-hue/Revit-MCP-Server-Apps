using Autodesk.Revit.DB;

namespace RevitMCPMEPCommandSet.Utils
{
    internal static class MepIds
    {
        public static long Value(ElementId id)
        {
            if (id == null || id == ElementId.InvalidElementId)
                return -1;
#if REVIT2024_OR_GREATER
            return id.Value;
#else
            return id.IntegerValue;
#endif
        }

        public static ElementId From(long id)
        {
#if REVIT2024_OR_GREATER
            return new ElementId(id);
#else
            return new ElementId((int)id);
#endif
        }

        public static bool IsCategory(Element element, BuiltInCategory category)
        {
            if (element?.Category == null)
                return false;
            return Value(element.Category.Id) == (long)category;
        }
    }
}
