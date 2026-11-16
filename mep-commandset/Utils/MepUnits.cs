using Autodesk.Revit.DB;

namespace RevitMCPMEPCommandSet.Utils
{
    internal static class MepUnits
    {
        public const double MinSegmentLengthFeet = (1.0 / 12.0) / 10.0;

        public static double MmToFt(double millimeters)
        {
#if REVIT2022_OR_GREATER
            return UnitUtils.ConvertToInternalUnits(millimeters, UnitTypeId.Millimeters);
#else
            return UnitUtils.ConvertToInternalUnits(millimeters, DisplayUnitType.DUT_MILLIMETERS);
#endif
        }

        public static double FtToMm(double feet)
        {
#if REVIT2022_OR_GREATER
            return UnitUtils.ConvertFromInternalUnits(feet, UnitTypeId.Millimeters);
#else
            return UnitUtils.ConvertFromInternalUnits(feet, DisplayUnitType.DUT_MILLIMETERS);
#endif
        }
    }
}
