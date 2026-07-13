using System.Threading.Tasks;

namespace VsClineAgent.Services
{
    internal interface ICommandOutputWriter
    {
        Task WriteLineAsync(string text);
    }

    internal sealed class NullCommandOutputWriter : ICommandOutputWriter
    {
        public Task WriteLineAsync(string text) => Task.CompletedTask;
    }
}
