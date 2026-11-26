using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Autodesk.Revit.UI;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Models.JsonRPC;
using RevitMCPSDK.API.Interfaces;
using revit_mcp_plugin.Configuration;
using revit_mcp_plugin.Utils;

namespace revit_mcp_plugin.Core
{
    public class SocketService
    {
        private static SocketService _instance;
        private TcpListener _listener;
        private Thread _listenerThread;
        private bool _isRunning;
        private int _port = revit_mcp_plugin.Panel.PanelBuildInfo.SocketPort;
        private UIApplication _uiApp;
        private ICommandRegistry _commandRegistry;
        private ILogger _logger;
        private CommandExecutor _commandExecutor;
        private readonly SessionToken _sessionToken = new SessionToken();
        private SecuritySettings _security = new SecuritySettings();

        // JSON-RPC implementation-defined server error codes (-32000 to -32099).
        private const int UnauthorizedErrorCode = -32001;
        private const int MethodDisabledErrorCode = -32002;
        private const string CodeExecutionMethod = "send_code_to_revit";

        public static SocketService Instance
        {
            get
            {
                if(_instance == null)
                    _instance = new SocketService();
                return _instance;
            }
        }

        private SocketService()
        {
            _commandRegistry = new RevitCommandRegistry();
            _logger = new Logger();
        }

        public bool IsRunning => _isRunning;

        public int Port
        {
            get => _port;
            set => _port = value;
        }

        /// <summary>
        /// In-process command dispatch for Agent Canvas embedded apps (Schedule / GBP).
        /// Must not be called from the Revit UI thread when the command waits on ExternalEvent.
        /// </summary>
        public object ExecuteMethod(string method, JObject parameters)
        {
            if (string.IsNullOrWhiteSpace(method))
                throw new ArgumentException("method is required", nameof(method));
            if (_commandRegistry == null)
                throw new InvalidOperationException("Socket service is not initialized.");

            if (!_commandRegistry.TryGetCommand(method, out var command))
                throw new InvalidOperationException("Method '" + method + "' not found");

            string requestId = "panel-app-" + Guid.NewGuid().ToString("N");
            return command.Execute(parameters ?? new JObject(), requestId);
        }

        // 初始化
        // Initialization.
        public void Initialize(UIApplication uiApp)
        {
            _uiApp = uiApp;

            // 初始化事件管理器
            // Initialize ExternalEventManager
            ExternalEventManager.Instance.Initialize(uiApp, _logger);

            // 记录当前 Revit 版本
            // Get the current Revit version.
            var versionAdapter = new RevitMCPSDK.API.Utils.RevitVersionAdapter(_uiApp.Application);
            string currentVersion = versionAdapter.GetRevitVersion();
            _logger.Info("当前 Revit 版本: {0}\nCurrent Revit version: {0}", currentVersion);



            // 创建命令执行器
            // Create CommandExecutor
            _commandExecutor = new CommandExecutor(_commandRegistry, _logger);

            // 加载配置并注册命令
            // Load configuration and register commands.
            ConfigurationManager configManager = new ConfigurationManager(_logger);
            configManager.LoadConfiguration();
            

            //// 从配置中读取服务端口
            //// Read the service port from the configuration.
            //if (configManager.Config.Settings.Port > 0)
            //{
            //    _port = configManager.Config.Settings.Port;
            //}
            _port = revit_mcp_plugin.Panel.PanelBuildInfo.SocketPort;

            // Security switches (code execution is off unless security.json says otherwise).
            _security = SecuritySettings.Load(msg => _logger.Warning(msg));
            _logger.Info("Code execution over MCP socket: {0}", _security.AllowCodeExecution ? "ENABLED" : "disabled");

            // 加载命令
            // Load command.
            CommandManager commandManager = new CommandManager(
                _commandRegistry, _logger, configManager, _uiApp);
            commandManager.LoadCommands();

            // Panel commands are registered in-process (Agent Canvas).
            Panel.PanelCommandFactory.Register(_commandRegistry, _uiApp);

            _logger.Info($"Socket service initialized on port {_port}");
        }

        public void Start()
        {
            if (_isRunning) return;

            try
            {
                // Loopback only: the MCP server always runs on the same machine as Revit.
                _listener = new TcpListener(IPAddress.Loopback, _port);
                _listener.Start();

                // Issue the token only after the port is ours, so a second Revit instance
                // that fails to bind never overwrites the first instance's token file.
                _sessionToken.Issue(_port);

                _isRunning = true;
                _listenerThread = new Thread(ListenForClients)
                {
                    IsBackground = true
                };
                _listenerThread.Start();
                _logger.Info("MCP server started on port {0}", _port);
            }
            catch (SocketException ex)
            {
                CleanupFailedStart();
                if (ex.SocketErrorCode == SocketError.AddressAlreadyInUse)
                {
                    throw new InvalidOperationException(
                        string.Format("Port {0} is already in use. Stop the other process and try again.", _port),
                        ex);
                }

                throw new InvalidOperationException(
                    string.Format("Unable to start MCP server on port {0}: {1}", _port, ex.Message),
                    ex);
            }
            catch (Exception ex)
            {
                CleanupFailedStart();
                throw new InvalidOperationException(
                    string.Format("Unable to start MCP server on port {0}: {1}", _port, ex.Message),
                    ex);
            }
        }

        public void Stop()
        {
            if (!_isRunning) return;

            _isRunning = false;
            _sessionToken.Revoke();

            try
            {
                _listener?.Stop();
                _listener = null;

                if (_listenerThread != null && _listenerThread.IsAlive)
                {
                    _listenerThread.Join(1000);
                }

                _logger.Info("MCP server stopped");
            }
            catch (Exception ex)
            {
                _logger.Error("Error stopping MCP server: {0}", ex.Message);
            }
        }

        private void CleanupFailedStart()
        {
            _isRunning = false;
            _sessionToken.Revoke();
            try
            {
                _listener?.Stop();
            }
            catch
            {
            }
            _listener = null;
        }

        private void ListenForClients()
        {
            try
            {
                while (_isRunning)
                {
                    TcpClient client = _listener.AcceptTcpClient();

                    Thread clientThread = new Thread(HandleClientCommunication)
                    {
                        IsBackground = true
                    };
                    clientThread.Start(client);
                }
            }
            catch (SocketException)
            {
                
            }
            catch(Exception)
            {
                // log
            }
        }

        private void HandleClientCommunication(object clientObj)
        {
            TcpClient tcpClient = (TcpClient)clientObj;
            NetworkStream stream = tcpClient.GetStream();

            try
            {
                // One Read is capped at this size. A Walls isolate is ~10KB of ids, so a single
                // 8192-byte read parsed an incomplete object and Revit returned Invalid JSON.
                byte[] buffer = new byte[8192];
                var pending = new StringBuilder();

                while (_isRunning && tcpClient.Connected)
                {
                    int bytesRead = 0;

                    try
                    {
                        bytesRead = stream.Read(buffer, 0, buffer.Length);
                    }
                    catch (IOException)
                    {
                        break;
                    }

                    if (bytesRead == 0)
                    {
                        break;
                    }

                    pending.Append(Encoding.UTF8.GetString(buffer, 0, bytesRead));
                    string message;
                    while (TryExtractJsonObject(pending, out message))
                    {
                        string response = ProcessJsonRPCRequest(message);
                        byte[] responseData = Encoding.UTF8.GetBytes(response);
                        stream.Write(responseData, 0, responseData.Length);
                    }
                }
            }
            catch(Exception)
            {
                // log
            }
            finally
            {
                tcpClient.Close();
            }
        }

        /// <summary>
        /// Take one complete top-level JSON object out of the TCP buffer.
        /// Returns false when the next object is still incomplete.
        /// </summary>
        private static bool TryExtractJsonObject(StringBuilder pending, out string message)
        {
            message = null;
            var text = pending.ToString();
            var start = -1;
            var depth = 0;
            var inString = false;
            var escape = false;
            for (var i = 0; i < text.Length; i++)
            {
                var c = text[i];
                if (inString)
                {
                    if (escape)
                    {
                        escape = false;
                        continue;
                    }
                    if (c == '\\')
                    {
                        escape = true;
                        continue;
                    }
                    if (c == '"') inString = false;
                    continue;
                }
                if (c == '"')
                {
                    inString = true;
                    continue;
                }
                if (c == '{')
                {
                    if (depth == 0) start = i;
                    depth++;
                }
                else if (c == '}' && depth > 0)
                {
                    depth--;
                    if (depth == 0 && start >= 0)
                    {
                        message = text.Substring(start, i - start + 1);
                        pending.Remove(0, i + 1);
                        return true;
                    }
                }
            }
            return false;
        }

        private string ProcessJsonRPCRequest(string requestJson)
        {
            JsonRPCRequest request;

            try
            {
                // 解析JSON-RPC请求
                // Parse JSON-RPC requests.
                JObject raw = JObject.Parse(requestJson);

                // Authenticate before touching the command registry.
                if (!_sessionToken.Matches(raw.Value<string>("auth")))
                {
                    _logger.Warning("Rejected MCP socket request without a valid session token (method: {0})",
                        raw.Value<string>("method") ?? "?");
                    return CreateErrorResponse(
                        raw.Value<string>("id"),
                        UnauthorizedErrorCode,
                        "Unauthorized: missing or invalid session token. The MCP server reads it from " +
                        SessionToken.GetTokenFilePath(_port) + " (or REVIT_MCP_TOKEN)."
                    );
                }

                request = raw.ToObject<JsonRPCRequest>();

                // 验证请求格式是否有效
                // Verify that the request format is valid.
                if (request == null || !request.IsValid())
                {
                    return CreateErrorResponse(
                        null,
                        JsonRPCErrorCodes.InvalidRequest,
                        "Invalid JSON-RPC request"
                    );
                }

                // Arbitrary code execution stays off unless security.json opts in.
                if (string.Equals(request.Method, CodeExecutionMethod, StringComparison.Ordinal) &&
                    !_security.AllowCodeExecution)
                {
                    return CreateErrorResponse(request.Id, MethodDisabledErrorCode,
                        "send_code_to_revit is disabled. To allow it, set \"allowCodeExecution\": true in " +
                        SecuritySettings.GetFilePath() + " and restart the MCP service in Revit.");
                }

                // 查找命令
                // Search for the command in the registry.
                if (!_commandRegistry.TryGetCommand(request.Method, out var command))
                {
                    return CreateErrorResponse(request.Id, JsonRPCErrorCodes.MethodNotFound,
                        $"Method '{request.Method}' not found");
                }

                // 执行命令
                // Execute command.
                try
                {                
                    object result = command.Execute(request.GetParamsObject(), request.Id);

                    return CreateSuccessResponse(request.Id, result);
                }
                catch (Exception ex)
                {
                    return CreateErrorResponse(request.Id, JsonRPCErrorCodes.InternalError, ex.Message);
                }
            }
            catch (JsonException)
            {
                // JSON解析错误
                // JSON parsing error.
                return CreateErrorResponse(
                    null,
                    JsonRPCErrorCodes.ParseError,
                    "Invalid JSON"
                );
            }
            catch (Exception ex)
            {
                // 处理请求时的其他错误
                // Catch other errors produced when processing requests.
                return CreateErrorResponse(
                    null,
                    JsonRPCErrorCodes.InternalError,
                    $"Internal error: {ex.Message}"
                );
            }
        }

        private string CreateSuccessResponse(string id, object result)
        {
            var response = new JsonRPCSuccessResponse
            {
                Id = id,
                Result = result is JToken jToken ? jToken : JToken.FromObject(result)
            };

            return response.ToJson();
        }

        private string CreateErrorResponse(string id, int code, string message, object data = null)
        {
            var response = new JsonRPCErrorResponse
            {
                Id = id,
                Error = new JsonRPCError
                {
                    Code = code,
                    Message = message,
                    Data = data != null ? JToken.FromObject(data) : null
                }
            };

            return response.ToJson();
        }
    }
}
