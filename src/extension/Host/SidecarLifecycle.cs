using System;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using VsClineAgent.Services;

namespace VsClineAgent.Host
{
    internal sealed class SidecarLifecycle : IDisposable
    {
        private readonly VsEditorService _editorService;
        private readonly VsCommandExecutionService _commandExecutionService;
        private readonly Action<string> _setStatus;
        private readonly SemaphoreSlim _startLock = new SemaphoreSlim(1, 1);
        private SidecarProcess? _process;
        private bool _disposed;

        public SidecarLifecycle(
            VsEditorService editorService,
            VsCommandExecutionService commandExecutionService,
            Action<string> setStatus)
        {
            _editorService = editorService;
            _commandExecutionService = commandExecutionService;
            _setStatus = setStatus;
        }

        public string? AssemblyDirectory { get; set; }
        public string? LastError { get; private set; }
        public bool IsRunning => _process != null && _process.IsRunning;

        public async Task<bool> EnsureRunningAsync()
        {
            await _startLock.WaitAsync().ConfigureAwait(false);
            try
            {
                if (_disposed)
                    return false;
                if (IsRunning)
                    return true;

                var assemblyDirectory = AssemblyDirectory ??
                    Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ??
                    AppDomain.CurrentDomain.BaseDirectory;
                DisposeProcessQuietly();
                _process = new SidecarProcess(assemblyDirectory, _editorService, _commandExecutionService);
                _setStatus("Preparing the LIG VS sidecar...");

                var process = _process ?? throw new InvalidOperationException("Cline sidecar process was not created.");
                var status = await Task.Run(() => process.EnsureStartedAsync(CancellationToken.None)).ConfigureAwait(false);
                LastError = null;
                _setStatus("LIG VS sidecar: " + status);
                return IsRunning;
            }
            catch (Exception ex)
            {
                LastError = "LIG VS sidecar failed to start: " + ex.Message;
                _setStatus(LastError);
                return false;
            }
            finally
            {
                _startLock.Release();
            }
        }

        public Task<bool> TryHandleWebviewMessageAsync(
            string rawJson,
            Func<object, Task> postToWebviewAsync,
            CancellationToken cancellationToken)
        {
            var process = _process;
            return process == null || !process.IsRunning
                ? Task.FromResult(false)
                : process.TryHandleWebviewMessageAsync(rawJson, postToWebviewAsync, cancellationToken);
        }

        public string GetNotRunningMessage()
        {
            return string.IsNullOrWhiteSpace(LastError) ? "LIG VS SDK sidecar is not running." : LastError!;
        }

        public void RecordError(Exception exception)
        {
            LastError = exception.ToString();
        }

        public void Dispose()
        {
            if (_disposed)
                return;
            _disposed = true;
            DisposeProcessQuietly();
            try { _commandExecutionService.Dispose(); } catch { }
            _startLock.Dispose();
        }

        private void DisposeProcessQuietly()
        {
            try { _process?.Dispose(); } catch { }
            finally { _process = null; }
        }
    }
}
