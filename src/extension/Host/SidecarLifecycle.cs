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
        private readonly CancellationTokenSource _shutdownCancellation = new CancellationTokenSource();
        private SidecarProcess? _process;
        private int _disposed;
		private int _readyGeneration;
		private int _transportGeneration;

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
		public event Action<int>? ReadyGenerationChanged;
		public event Action<int>? TransportUnavailable;

        public async Task<bool> EnsureRunningAsync(CancellationToken cancellationToken = default)
        {
            using (var startupCancellation = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken,
                _shutdownCancellation.Token))
            {
                var lockTaken = false;
                try
                {
                    await _startLock.WaitAsync(startupCancellation.Token).ConfigureAwait(false);
                    lockTaken = true;
                    if (Volatile.Read(ref _disposed) != 0)
                        return false;
                    if (IsRunning)
                        return true;

                    var assemblyDirectory = AssemblyDirectory ??
                        Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ??
                        AppDomain.CurrentDomain.BaseDirectory;
                    DisposeProcessQuietly();
                    startupCancellation.Token.ThrowIfCancellationRequested();
                    _process = new SidecarProcess(assemblyDirectory, _editorService, _commandExecutionService);
					_process.Exited += OnSidecarProcessExited;
                    _setStatus("LIG VS 사이드카를 준비하는 중입니다. 처음 실행하거나 업데이트한 직후에는 의존성 구성에 시간이 걸릴 수 있습니다...");

                    var process = _process ?? throw new InvalidOperationException("Cline sidecar process was not created.");
                    var status = await Task.Run(
                        () => process.EnsureStartedAsync(startupCancellation.Token),
                        startupCancellation.Token).ConfigureAwait(false);
                    LastError = null;
                    _setStatus("LIG VS 사이드카: " + status);
					if (IsRunning)
					{
						var generation = Interlocked.Increment(ref _readyGeneration);
						try { ReadyGenerationChanged?.Invoke(generation); }
						catch (Exception ex) { InteractionLog.Write("host", "sidecar.readyNotificationFailed", new { error = ex.Message }); }
					}
                    return IsRunning;
                }
                catch (OperationCanceledException) when (startupCancellation.IsCancellationRequested)
                {
                    DisposeProcessQuietly();
                    return false;
                }
                catch (Exception ex)
                {
                    LastError = "LIG VS 사이드카를 시작하지 못했습니다: " + ex.Message;
                    _setStatus(LastError);
                    return false;
                }
                finally
                {
                    if (lockTaken)
                        _startLock.Release();
                }
            }
        }

		public async Task WarmSdkAsync(CancellationToken cancellationToken = default)
		{
			var process = _process;
			if (process == null || !process.IsRunning)
				return;

			try
			{
				var status = await process.WarmSdkAsync(cancellationToken).ConfigureAwait(false);
				InteractionLog.Write("host", "sidecar.sdkWarmupCompleted", new { status });
			}
			catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
			{
			}
			catch (Exception ex)
			{
				InteractionLog.Write("host", "sidecar.sdkWarmupFailed", new { error = ex.Message });
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
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
                return;
            _shutdownCancellation.Cancel();
			ReadyGenerationChanged = null;
			TransportUnavailable = null;
            DisposeProcessQuietly();
            try { _commandExecutionService.Dispose(); } catch { }
        }

        private void DisposeProcessQuietly()
        {
			var process = _process;
			_process = null;
			if (process == null)
				return;
			process.Exited -= OnSidecarProcessExited;
			try { process.Dispose(); } catch { }
        }

		private void OnSidecarProcessExited(SidecarProcess process)
		{
			if (Volatile.Read(ref _disposed) != 0 || !ReferenceEquals(_process, process))
				return;
			var generation = Interlocked.Increment(ref _transportGeneration);
			try { TransportUnavailable?.Invoke(generation); }
			catch (Exception ex) { InteractionLog.Write("host", "sidecar.exitNotificationFailed", new { error = ex.Message }); }
		}
    }
}
