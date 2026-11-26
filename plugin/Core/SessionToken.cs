using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace revit_mcp_plugin.Core
{
    /// <summary>
    /// Per-session shared secret for the local MCP socket.
    /// The plugin writes it to %LOCALAPPDATA%\RevitMCP\token-&lt;port&gt; (readable only by the
    /// current Windows user) and the MCP server sends it as "auth" on every JSON-RPC request.
    /// A new token is generated every time the socket service starts.
    /// </summary>
    public sealed class SessionToken
    {
        private string _value;
        private string _filePath;

        public static string GetTokenFilePath(int port)
        {
            string root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(root, "RevitMCP", "token-" + port);
        }

        /// <summary>Generate a fresh token and write it to the per-user token file.</summary>
        public void Issue(int port)
        {
            var bytes = new byte[32];
            using (var rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }

            var sb = new StringBuilder(bytes.Length * 2);
            foreach (byte b in bytes) sb.Append(b.ToString("x2"));
            _value = sb.ToString();

            _filePath = GetTokenFilePath(port);
            Directory.CreateDirectory(Path.GetDirectoryName(_filePath));
            File.WriteAllText(_filePath, _value, new UTF8Encoding(false));
        }

        /// <summary>Forget the token and remove the token file.</summary>
        public void Revoke()
        {
            _value = null;
            try
            {
                if (_filePath != null && File.Exists(_filePath)) File.Delete(_filePath);
            }
            catch
            {
                // Best effort: a stale file only holds a token nobody accepts any more.
            }
            _filePath = null;
        }

        /// <summary>Constant-time comparison against the current token.</summary>
        public bool Matches(string candidate)
        {
            string expected = _value;
            if (expected == null || candidate == null) return false;

            byte[] a = Encoding.UTF8.GetBytes(expected);
            byte[] b = Encoding.UTF8.GetBytes(candidate);
            if (a.Length != b.Length) return false;

            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }
    }
}
