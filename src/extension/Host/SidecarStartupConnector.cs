using System;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Host
{
    internal static class SidecarStartupConnector
    {
        public static async Task ConnectWithRetryAsync(
            Func<bool> hasExited,
            Func<string> exitCode,
            Func<int, CancellationToken, Task> connect,
            CancellationToken cancellationToken,
            int maximumAttempts = 30,
            int connectTimeoutMilliseconds = 500,
            int retryDelayMilliseconds = 100)
        {
            if (maximumAttempts < 1) throw new ArgumentOutOfRangeException(nameof(maximumAttempts));
            if (connectTimeoutMilliseconds < 1) throw new ArgumentOutOfRangeException(nameof(connectTimeoutMilliseconds));
            if (retryDelayMilliseconds < 0) throw new ArgumentOutOfRangeException(nameof(retryDelayMilliseconds));

            Exception? lastError = null;
            for (var attempt = 0; attempt < maximumAttempts; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (hasExited())
                {
                    throw new InvalidOperationException(
                        "Cline sidecar exited before the pipe connection was established. Exit code: " + exitCode());
                }

                try
                {
                    await connect(connectTimeoutMilliseconds, cancellationToken).ConfigureAwait(false);
                    return;
                }
                catch (Exception ex) when (!(ex is OperationCanceledException))
                {
                    lastError = ex;
                    if (attempt + 1 < maximumAttempts && retryDelayMilliseconds > 0)
                        await Task.Delay(retryDelayMilliseconds, cancellationToken).ConfigureAwait(false);
                }
            }

            throw new TimeoutException("Timed out while connecting to the Cline sidecar pipe.", lastError);
        }
    }
}
