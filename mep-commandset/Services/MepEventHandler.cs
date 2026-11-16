using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPMEPCommandSet.Services
{
    public sealed class MepEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        private string _command;
        private JObject _parameters;

        public object Result { get; private set; }
        public string Error { get; private set; }

        public void Prepare(string command, JObject parameters)
        {
            _command = command;
            _parameters = parameters ?? new JObject();
            Result = null;
            Error = null;
            _done.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                Document doc = app?.ActiveUIDocument?.Document;
                if (doc == null)
                    throw new InvalidOperationException("No active Revit document.");
                Result = MepOperations.Run(doc, _command, _parameters);
            }
            catch (Exception ex)
            {
                Error = string.IsNullOrWhiteSpace(ex.Message) ? ex.GetType().Name : ex.Message;
                Result = null;
            }
            finally
            {
                _done.Set();
            }
        }

        public bool WaitForCompletion(int timeoutMs)
        {
            return _done.WaitOne(timeoutMs);
        }

        public string GetName()
        {
            return "Revit MEP Command Set";
        }
    }
}
