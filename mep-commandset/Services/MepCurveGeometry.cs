using Autodesk.Revit.DB;
using RevitMCPMEPCommandSet.Utils;

namespace RevitMCPMEPCommandSet.Services
{
    /// <summary>
    /// Connector math shared by pipe, duct, and cable tray fittings.
    /// Angle and collinearity checks follow RevitCLI (MIT), https://github.com/iandelivery/RevitCLI.
    /// </summary>
    internal static class MepCurveGeometry
    {
        public const double PerpendicularityToleranceDeg = 1.0;
        public const double CollinearDotTolerance = 1e-6;

        public static List<Connector> Connectors(MEPCurve element)
        {
            var list = new List<Connector>();
            if (element?.ConnectorManager?.Connectors == null)
                return list;
            foreach (Connector connector in element.ConnectorManager.Connectors)
                list.Add(connector);
            return list;
        }

        public static (Connector a, Connector b)? FindClosestConnectors(MEPCurve a, MEPCurve b)
        {
            Connector bestA = null;
            Connector bestB = null;
            double minDistance = double.MaxValue;
            bool foundOpen = false;

            foreach (Connector ca in Connectors(a))
            {
                foreach (Connector cb in Connectors(b))
                {
                    if (ca.Domain != cb.Domain)
                        continue;
                    bool open = !ca.IsConnected && !cb.IsConnected;
                    if (foundOpen && !open)
                        continue;
                    double distance = ca.Origin.DistanceTo(cb.Origin);
                    if (bestA != null && open == foundOpen && distance >= minDistance)
                        continue;
                    foundOpen = open;
                    minDistance = distance;
                    bestA = ca;
                    bestB = cb;
                }
            }

            if (bestA == null || bestB == null)
                return null;
            return (bestA, bestB);
        }

        public static Connector FindClosestConnector(MEPCurve element, XYZ reference)
        {
            Connector best = null;
            double minDistance = double.MaxValue;
            foreach (Connector connector in Connectors(element))
            {
                if (connector.IsConnected)
                    continue;
                double distance = connector.Origin.DistanceTo(reference);
                if (distance < minDistance)
                {
                    minDistance = distance;
                    best = connector;
                }
            }
            if (best != null)
                return best;

            foreach (Connector connector in Connectors(element))
            {
                double distance = connector.Origin.DistanceTo(reference);
                if (distance < minDistance)
                {
                    minDistance = distance;
                    best = connector;
                }
            }
            return best;
        }

        public static Connector FindClosestConnectorToCurve(MEPCurve element, Curve referenceCurve)
        {
            Connector best = null;
            double minDistance = double.MaxValue;
            foreach (Connector connector in Connectors(element))
            {
                double distance = referenceCurve.Distance(connector.Origin);
                if (connector.IsConnected && best != null)
                    continue;
                if (distance < minDistance)
                {
                    minDistance = distance;
                    best = connector;
                }
            }
            return best;
        }

        public static Connector ConnectorAt(MEPCurve element, int index)
        {
            List<Connector> list = Connectors(element);
            if (index < 0 || index >= list.Count)
                throw new ArgumentException(
                    "Connector index " + index + " is out of range (0-" + Math.Max(0, list.Count - 1) + ").");
            return list[index];
        }

        public static XYZ ComputeIntersection(Curve a, Curve b)
        {
            if (a == null || b == null)
                return null;
#if REVIT2027_OR_GREATER
            CurveIntersectResult hit = a.Intersect(b, CurveIntersectResultOption.Detailed);
            if (hit == null || hit.Result != SetComparisonResult.Overlap)
                return null;
            var overlaps = hit.GetOverlaps();
            if (overlaps == null)
                return null;
            foreach (CurveOverlapPoint overlap in overlaps)
            {
                if (overlap?.Point != null)
                    return overlap.Point;
            }
            return null;
#else
            IntersectionResultArray result;
            if (a.Intersect(b, out result) == SetComparisonResult.Overlap && result != null && result.Size > 0)
                return result.get_Item(0).XYZPoint;
            return null;
#endif
        }

        public static Curve LocationCurve(MEPCurve element)
        {
            return (element?.Location as LocationCurve)?.Curve;
        }

        public static XYZ Direction(Connector connector)
        {
            return connector.CoordinateSystem.BasisZ;
        }

        public static double AngleBetweenDegrees(Connector a, Connector b)
        {
            double dot = Direction(a).DotProduct(Direction(b));
            dot = Math.Max(-1.0, Math.Min(1.0, dot));
            return Math.Acos(dot) * 180.0 / Math.PI;
        }

        public static bool AreConnectorsCollinear(Connector a, Connector b)
        {
            if (a == null || b == null)
                return false;
            double dot = Direction(a).DotProduct(Direction(b));
            return Math.Abs(dot + 1.0) < CollinearDotTolerance;
        }

        public static void ValidateElbowPair(Connector a, Connector b)
        {
            ValidateDistinctPair(a, b);
            double angle = AngleBetweenDegrees(a, b);
            if (angle < 2.0 || angle > 95.0)
                throw new ArgumentException(
                    "Connector angle " + angle.ToString("F1") + "° is outside the elbow range (2°–95°).");
        }

        public static void ValidateCollinearPair(Connector a, Connector b)
        {
            ValidateDistinctPair(a, b);
            if (!AreConnectorsCollinear(a, b))
            {
                double angle = AngleBetweenDegrees(a, b);
                throw new ArgumentException(
                    "Connectors are not collinear (angle " + angle.ToString("F1") + "°, expected about 180°).");
            }
        }

        public static void ValidatePerpendicular(Curve main, Curve branch)
        {
            XYZ mainDir = main.GetEndPoint(1).Subtract(main.GetEndPoint(0)).Normalize();
            XYZ branchDir = branch.GetEndPoint(1).Subtract(branch.GetEndPoint(0)).Normalize();
            double dot = Math.Abs(mainDir.DotProduct(branchDir));
            double angle = Math.Acos(Math.Min(1.0, dot)) * 180.0 / Math.PI;
            if (Math.Abs(angle - 90.0) > PerpendicularityToleranceDeg)
                throw new ArgumentException(
                    "Branch is not perpendicular to the main (angle " + angle.ToString("F1") + "°, required 89°–91°).");
        }

        private static void ValidateDistinctPair(Connector a, Connector b)
        {
            if (a == null || b == null)
                throw new ArgumentException("Could not resolve a connector pair.");
            if (MepIds.Value(a.Owner.Id) == MepIds.Value(b.Owner.Id))
                throw new ArgumentException("Cannot create a fitting between connectors of the same element.");
            if (a.Domain != b.Domain)
                throw new ArgumentException("Connectors must belong to the same domain.");
        }
    }
}
