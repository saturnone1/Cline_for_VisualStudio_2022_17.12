using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class WindowsProcessJobTests
    {
        [Fact]
        public void ClosingJobTerminatesAssignedProcess()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                return;

            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/d /c ping 127.0.0.1 -n 30 >nul",
                UseShellExecute = false,
                CreateNoWindow = true,
            }) ?? throw new InvalidOperationException("Test process did not start.");
            using (var job = new WindowsProcessJob())
            {
                job.Assign(process);
            }

            Assert.True(process.WaitForExit(5000), "The assigned process survived after its job handle closed.");
        }

        [Fact]
        public void ClosingJobTerminatesDescendantProcessTree()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                return;

            var testRoot = Path.Combine(Path.GetTempPath(), "vscline-job-tree-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(testRoot);
            var triggerPath = Path.Combine(testRoot, "start.flag");
            var childPidPath = Path.Combine(testRoot, "child.pid");
            var command = "$trigger='" + EscapePowerShell(triggerPath) + "';" +
                          "$pidFile='" + EscapePowerShell(childPidPath) + "';" +
                          "while(-not (Test-Path -LiteralPath $trigger)){Start-Sleep -Milliseconds 25};" +
                          "$child=Start-Process ping.exe -ArgumentList '127.0.0.1','-n','30' -PassThru;" +
                          "Set-Content -LiteralPath $pidFile -Value $child.Id;" +
                          "Wait-Process -Id $child.Id";
            try
            {
                using var parent = Process.Start(new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -Command \"" + command.Replace("\"", "\\\"") + "\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                }) ?? throw new InvalidOperationException("Parent test process did not start.");
                using (var job = new WindowsProcessJob())
                {
                    job.Assign(parent);
                    File.WriteAllText(triggerPath, "go");
                    var childPid = 0;
                    Assert.True(
                        SpinWait.SpinUntil(() => TryReadProcessId(childPidPath, out childPid), 5000),
                        "The descendant process did not start.");
                    using var child = Process.GetProcessById(childPid);
                    job.Dispose();
                    Assert.True(parent.WaitForExit(5000), "The assigned parent survived after its job handle closed.");
                    Assert.True(child.WaitForExit(5000), "A descendant process survived after its job handle closed.");
                }
            }
            finally
            {
                try { Directory.Delete(testRoot, true); } catch { }
            }
        }

        private static bool TryReadProcessId(string path, out int processId)
        {
            processId = 0;
            try { return File.Exists(path) && int.TryParse(File.ReadAllText(path).Trim(), out processId); }
            catch (IOException) { return false; }
        }

        private static string EscapePowerShell(string value) => value.Replace("'", "''");
    }
}
