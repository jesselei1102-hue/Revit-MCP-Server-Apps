using Newtonsoft.Json.Linq;

namespace RevitMCPMEPCommandSet.Utils
{
    internal static class MepParams
    {
        public static JObject Root(JObject parameters)
        {
            if (parameters == null)
                return new JObject();
            return parameters["input"] as JObject ?? parameters;
        }

        public static JToken Token(JObject parameters, params string[] names)
        {
            if (parameters == null)
                return null;
            foreach (string name in names)
            {
                JToken token = parameters[name];
                if (token != null && token.Type != JTokenType.Null)
                    return token;
            }
            return null;
        }

        public static bool Has(JObject parameters, params string[] names)
        {
            return Token(parameters, names) != null;
        }

        public static long RequiredLong(JObject parameters, string label, params string[] names)
        {
            JToken token = Token(parameters, names);
            if (token == null)
                throw new ArgumentException("Missing " + label + ".");
            return token.Value<long>();
        }

        public static long? OptionalLong(JObject parameters, params string[] names)
        {
            JToken token = Token(parameters, names);
            if (token == null)
                return null;
            return token.Value<long>();
        }

        public static double RequiredDouble(JObject parameters, string label, params string[] names)
        {
            JToken token = Token(parameters, names);
            if (token == null)
                throw new ArgumentException("Missing " + label + ".");
            return token.Value<double>();
        }

        public static double? OptionalDouble(JObject parameters, params string[] names)
        {
            JToken token = Token(parameters, names);
            if (token == null)
                return null;
            return token.Value<double>();
        }

        public static string RequiredString(JObject parameters, string label, params string[] names)
        {
            JToken token = Token(parameters, names);
            if (token == null || string.IsNullOrWhiteSpace(token.Value<string>()))
                throw new ArgumentException("Missing " + label + ".");
            return token.Value<string>().Trim();
        }

        public static string OptionalString(JObject parameters, params string[] names)
        {
            JToken token = Token(parameters, names);
            if (token == null)
                return null;
            string value = token.Value<string>();
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }

        public static bool Bool(JObject parameters, bool fallback, params string[] names)
        {
            JToken token = Token(parameters, names);
            if (token == null)
                return fallback;
            if (token.Type == JTokenType.Boolean)
                return token.Value<bool>();
            return bool.TryParse(token.Value<string>(), out bool parsed) ? parsed : fallback;
        }

        public static int Limit(JObject parameters, int fallback, int max)
        {
            long? value = OptionalLong(parameters, "limit");
            if (!value.HasValue)
                return fallback;
            if (value.Value < 1)
                return 1;
            if (value.Value > max)
                return max;
            return (int)value.Value;
        }
    }
}
