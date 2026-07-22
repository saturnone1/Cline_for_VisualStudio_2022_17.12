using System;
using System.Collections.Generic;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class ToolWindowLifetimeTests
    {
        [Fact]
        public void Dispose_runs_every_owner_cleanup_once_in_order()
        {
            var calls = new List<string>();
            var lifetime = new ToolWindowLifetime(
                () => calls.Add("events"),
                () => calls.Add("webview"),
                () => calls.Add("loading"),
                () => calls.Add("sidecar"));

            lifetime.Dispose();
            lifetime.Dispose();

            Assert.True(lifetime.IsDisposed);
            Assert.Equal(new[] { "events", "webview", "loading", "sidecar" }, calls);
        }

        [Fact]
        public void Dispose_continues_after_an_owner_cleanup_fails()
        {
            var calls = new List<string>();
            var lifetime = new ToolWindowLifetime(
                () => throw new InvalidOperationException("detach failed"),
                () => calls.Add("webview"),
                () => calls.Add("sidecar"));

            lifetime.Dispose();

            Assert.Equal(new[] { "webview", "sidecar" }, calls);
        }
    }
}
