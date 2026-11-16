using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;
using RevitMCPMEPCommandSet.Utils;

namespace RevitMCPMEPCommandSet.Services
{
    internal static class MepFittingService
    {
        private static readonly Dictionary<string, (string Discipline, string Type)> Commands =
            new Dictionary<string, (string, string)>
            {
                ["create_pipe_elbow_fitting"] = ("pipe", "elbow"),
                ["create_pipe_transition_fitting"] = ("pipe", "transition"),
                ["create_pipe_union_fitting"] = ("pipe", "union"),
                ["create_pipe_tee_fitting"] = ("pipe", "tee"),
                ["create_pipe_cross_fitting"] = ("pipe", "cross"),
                ["create_pipe_takeoff_fitting"] = ("pipe", "takeoff"),
                ["create_duct_elbow_fitting"] = ("duct", "elbow"),
                ["create_duct_transition_fitting"] = ("duct", "transition"),
                ["create_duct_union_fitting"] = ("duct", "union"),
                ["create_duct_tee_fitting"] = ("duct", "tee"),
                ["create_duct_cross_fitting"] = ("duct", "cross"),
                ["create_duct_takeoff_fitting"] = ("duct", "takeoff"),
                ["create_elbow_fitting"] = ("cable_tray", "elbow"),
                ["create_transition_fitting"] = ("cable_tray", "transition"),
                ["create_union_fitting"] = ("cable_tray", "union"),
                ["create_tee_fitting"] = ("cable_tray", "tee"),
                ["create_cross_fitting"] = ("cable_tray", "cross")
            };

        public static bool IsFittingCommand(string command)
        {
            return command == "create_mep_fitting" || Commands.ContainsKey(command);
        }

        public static object Create(Document doc, string command, JObject parameters)
        {
            string discipline;
            string type;
            if (command == "create_mep_fitting")
            {
                type = MepParams.RequiredString(parameters, "type", "type").ToLowerInvariant();
                discipline = NormalizeDiscipline(MepParams.RequiredString(parameters, "class", "class", "discipline"));
                if (type == "cross")
                    throw new ArgumentException(
                        "create_mep_fitting cannot carry a cross. Use create_" + CrossName(discipline) + "cross_fitting with two main halves and two branches.");
            }
            else
            {
                (discipline, type) = Commands[command];
            }

            if (type != "elbow" && type != "transition" && type != "union" && type != "tee" && type != "cross" && type != "takeoff")
                throw new ArgumentException("type must be elbow, transition, union, tee, cross, or takeoff.");
            if (discipline == "cable_tray" && type == "takeoff")
                throw new ArgumentException("Cable trays do not support takeoff fittings.");

            return MepCurveService.InTransaction(doc, command, parameters, () =>
            {
                FamilyInstance fitting;
                Dictionary<string, object> extra = null;
                switch (type)
                {
                    case "elbow":
                        fitting = Elbow(doc, parameters, discipline);
                        break;
                    case "transition":
                        fitting = TransitionOrUnion(doc, parameters, discipline, true);
                        break;
                    case "union":
                        fitting = TransitionOrUnion(doc, parameters, discipline, false);
                        break;
                    case "tee":
                        (fitting, extra) = Tee(doc, parameters, discipline);
                        break;
                    case "takeoff":
                        fitting = Takeoff(doc, parameters, discipline);
                        break;
                    default:
                        fitting = Cross(doc, parameters, discipline);
                        break;
                }

                var result = new Dictionary<string, object>
                {
                    ["fittingId"] = MepIds.Value(fitting.Id),
                    ["fittingType"] = type,
                    ["class"] = discipline
                };
                if (extra != null)
                {
                    foreach (KeyValuePair<string, object> pair in extra)
                        result[pair.Key] = pair.Value;
                }
                return result;
            });
        }

        private static FamilyInstance Elbow(Document doc, JObject parameters, string discipline)
        {
            (Connector a, Connector b) = ResolvePair(doc, parameters, discipline);
            MepCurveGeometry.ValidateElbowPair(a, b);
            return doc.Create.NewElbowFitting(a, b);
        }

        private static FamilyInstance TransitionOrUnion(Document doc, JObject parameters, string discipline, bool transition)
        {
            (Connector a, Connector b) = ResolvePair(doc, parameters, discipline);
            MepCurveGeometry.ValidateCollinearPair(a, b);
            bool differs = MepCurveService.ReadSize((MEPCurve)a.Owner).DiffersFrom(MepCurveService.ReadSize((MEPCurve)b.Owner));
            if (transition && !differs)
                throw new ArgumentException("Both ends are the same size. Use a union.");
            if (!transition && differs)
                throw new ArgumentException("Sizes differ. Use a transition.");
            return transition
                ? doc.Create.NewTransitionFitting(a, b)
                : doc.Create.NewUnionFitting(a, b);
        }

        private static (FamilyInstance Fitting, Dictionary<string, object> Extra) Tee(Document doc, JObject parameters, string discipline)
        {
            long mainId = MepParams.RequiredLong(parameters, "main element id", "mainElementId", "main_element_id", "elementId1", "element_id_1");
            long branchId = MepParams.RequiredLong(parameters, "branch element id", "branchElementId", "branch_element_id", "elementId2", "element_id_2");
            if (mainId == branchId)
                throw new ArgumentException("Main and branch must be different elements.");
            MEPCurve main = MepCurveService.RequireCurve(doc, mainId, discipline);
            MEPCurve branch = MepCurveService.RequireCurve(doc, branchId, discipline);
            Curve mainCurve = MepCurveGeometry.LocationCurve(main);
            Curve branchCurve = MepCurveGeometry.LocationCurve(branch);
            if (mainCurve == null || branchCurve == null)
                throw new ArgumentException("Element has no location curve.");
            XYZ intersection = MepCurveGeometry.ComputeIntersection(mainCurve, branchCurve);
            if (intersection == null)
                throw new ArgumentException("Branch does not intersect the main.");
            MepCurveGeometry.ValidatePerpendicular(mainCurve, branchCurve);

            List<Connector> ends = MepCurveGeometry.Connectors(main);
            if (ends.Count < 2)
                throw new ArgumentException("Main element needs two end connectors.");
            Connector branchConnector = BranchConnector(branch, parameters, intersection, null);
            if (branchConnector.Domain != ends[0].Domain)
                throw new ArgumentException("Main and branch connectors are in different domains.");

            FamilyInstance fitting = doc.Create.NewTeeFitting(ends[0], ends[1], branchConnector);
            return (fitting, new Dictionary<string, object>
            {
                ["intersection"] = new Dictionary<string, object>
                {
                    ["x"] = Math.Round(MepUnits.FtToMm(intersection.X), 3),
                    ["y"] = Math.Round(MepUnits.FtToMm(intersection.Y), 3),
                    ["z"] = Math.Round(MepUnits.FtToMm(intersection.Z), 3)
                }
            });
        }

        private static FamilyInstance Takeoff(Document doc, JObject parameters, string discipline)
        {
            long branchId = MepParams.RequiredLong(parameters, "branch element id", "branchElementId", "branch_element_id", "elementId1", "element_id_1");
            long mainId = MepParams.RequiredLong(parameters, "main element id", "mainElementId", "main_element_id", "elementId2", "element_id_2");
            MEPCurve branch = MepCurveService.RequireCurve(doc, branchId, discipline);
            MEPCurve main = MepCurveService.RequireCurve(doc, mainId, discipline);
            Curve mainCurve = MepCurveGeometry.LocationCurve(main);
            if (mainCurve == null)
                throw new ArgumentException("Main element has no location curve.");
            Connector branchConnector = BranchConnector(branch, parameters, null, mainCurve);
            return doc.Create.NewTakeoffFitting(branchConnector, main);
        }

        private static FamilyInstance Cross(Document doc, JObject parameters, string discipline)
        {
            long main1Id = MepParams.RequiredLong(parameters, "mainElementId1", "mainElementId1", "main_element_id_1");
            long main2Id = MepParams.RequiredLong(parameters, "mainElementId2", "mainElementId2", "main_element_id_2");
            long branch1Id = MepParams.RequiredLong(parameters, "branchElementId1", "branchElementId1", "branch_element_id_1");
            long branch2Id = MepParams.RequiredLong(parameters, "branchElementId2", "branchElementId2", "branch_element_id_2");
            var ids = new[] { main1Id, main2Id, branch1Id, branch2Id };
            if (ids.Distinct().Count() != 4)
                throw new ArgumentException("A cross needs four distinct elements: two main halves and two branches.");

            MEPCurve main1 = MepCurveService.RequireCurve(doc, main1Id, discipline);
            MEPCurve main2 = MepCurveService.RequireCurve(doc, main2Id, discipline);
            MEPCurve branch1 = MepCurveService.RequireCurve(doc, branch1Id, discipline);
            MEPCurve branch2 = MepCurveService.RequireCurve(doc, branch2Id, discipline);
            Curve mainCurve = MepCurveGeometry.LocationCurve(main1);
            Curve branchCurve = MepCurveGeometry.LocationCurve(branch1);
            XYZ junction = MepCurveGeometry.ComputeIntersection(mainCurve, branchCurve)
                ?? MepCurveGeometry.ComputeIntersection(mainCurve, MepCurveGeometry.LocationCurve(main2));
            if (junction == null)
                throw new ArgumentException("Could not find the cross junction. Split the main first, then pass both halves.");
            if (branchCurve != null)
                MepCurveGeometry.ValidatePerpendicular(mainCurve, branchCurve);

            Connector c1 = MepCurveGeometry.FindClosestConnector(main1, junction);
            Connector c2 = MepCurveGeometry.FindClosestConnector(main2, junction);
            Connector c3 = MepCurveGeometry.FindClosestConnector(branch1, junction);
            Connector c4 = MepCurveGeometry.FindClosestConnector(branch2, junction);
            if (c1 == null || c2 == null || c3 == null || c4 == null)
                throw new ArgumentException("Could not resolve four connectors at the junction.");
            return doc.Create.NewCrossFitting(c1, c2, c3, c4);
        }

        private static (Connector A, Connector B) ResolvePair(Document doc, JObject parameters, string discipline)
        {
            long id1 = MepParams.RequiredLong(parameters, "elementId1", "elementId1", "element_id_1");
            long id2 = MepParams.RequiredLong(parameters, "elementId2", "elementId2", "element_id_2");
            if (id1 == id2)
                throw new ArgumentException("elementId1 and elementId2 must be different elements.");
            MEPCurve first = MepCurveService.RequireCurve(doc, id1, discipline);
            MEPCurve second = MepCurveService.RequireCurve(doc, id2, discipline);
            long? index1 = MepParams.OptionalLong(parameters, "connectorIndex1", "connector_index_1");
            long? index2 = MepParams.OptionalLong(parameters, "connectorIndex2", "connector_index_2");
            if (!index1.HasValue && !index2.HasValue)
            {
                (Connector a, Connector b)? pair = MepCurveGeometry.FindClosestConnectors(first, second);
                if (!pair.HasValue)
                    throw new ArgumentException("No connector pair with a matching domain was found.");
                return pair.Value;
            }

            Connector c1 = index1.HasValue
                ? MepCurveGeometry.ConnectorAt(first, (int)index1.Value)
                : MepCurveGeometry.FindClosestConnectors(first, second)?.a;
            Connector c2 = index2.HasValue
                ? MepCurveGeometry.ConnectorAt(second, (int)index2.Value)
                : MepCurveGeometry.FindClosestConnectors(first, second)?.b;
            if (c1 == null || c2 == null)
                throw new ArgumentException("Could not resolve a connector pair.");
            return (c1, c2);
        }

        private static Connector BranchConnector(MEPCurve branch, JObject parameters, XYZ intersection, Curve mainCurve)
        {
            long? index = MepParams.OptionalLong(parameters, "branchConnectorIndex", "branch_connector_index", "connectorIndex2", "connector_index_2");
            if (index.HasValue)
                return MepCurveGeometry.ConnectorAt(branch, (int)index.Value);
            Connector connector = intersection != null
                ? MepCurveGeometry.FindClosestConnector(branch, intersection)
                : MepCurveGeometry.FindClosestConnectorToCurve(branch, mainCurve);
            if (connector == null)
                throw new ArgumentException("Could not resolve a branch connector.");
            return connector;
        }

        private static string NormalizeDiscipline(string value)
        {
            string discipline = value.Trim().ToLowerInvariant().Replace(" ", "_");
            if (discipline == "cabletray")
                discipline = "cable_tray";
            if (discipline != "pipe" && discipline != "duct" && discipline != "cable_tray")
                throw new ArgumentException("class must be pipe, duct, or cable_tray.");
            return discipline;
        }

        private static string CrossName(string discipline)
        {
            return discipline == "cable_tray" ? "" : discipline + "_";
        }
    }
}
