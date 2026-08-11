using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace VsClineAgent.Host
{
    internal sealed class BoundedUtf8LineReader
    {
        private readonly Stream _stream;
        private readonly int _maximumLineBytes;
        private readonly byte[] _readBuffer = new byte[8192];
        private readonly MemoryStream _lineBuffer = new MemoryStream();
        private readonly UTF8Encoding _encoding = new UTF8Encoding(false, true);
        private int _readOffset;
        private int _readCount;

        public BoundedUtf8LineReader(Stream stream, int maximumLineBytes)
        {
            _stream = stream ?? throw new ArgumentNullException(nameof(stream));
            if (maximumLineBytes < 1)
                throw new ArgumentOutOfRangeException(nameof(maximumLineBytes));
            _maximumLineBytes = maximumLineBytes;
        }

        public async Task<string?> ReadLineAsync(CancellationToken cancellationToken)
        {
            while (true)
            {
                if (_readOffset >= _readCount)
                {
                    _readCount = await _stream.ReadAsync(_readBuffer, 0, _readBuffer.Length, cancellationToken)
                        .ConfigureAwait(false);
                    _readOffset = 0;
                    if (_readCount == 0)
                        return _lineBuffer.Length == 0 ? null : CompleteLine();
                }

                var newlineIndex = Array.IndexOf(_readBuffer, (byte)'\n', _readOffset, _readCount - _readOffset);
                var segmentEnd = newlineIndex >= 0 ? newlineIndex : _readCount;
                Append(_readBuffer, _readOffset, segmentEnd - _readOffset);
                _readOffset = newlineIndex >= 0 ? newlineIndex + 1 : _readCount;
                if (newlineIndex >= 0)
                    return CompleteLine();
            }
        }

        private void Append(byte[] buffer, int offset, int count)
        {
            if (_lineBuffer.Length + count > _maximumLineBytes)
                throw new InvalidDataException($"JSON-RPC message exceeds the configured {_maximumLineBytes}-byte limit.");
            _lineBuffer.Write(buffer, offset, count);
        }

        private string CompleteLine()
        {
            var length = checked((int)_lineBuffer.Length);
            var bytes = _lineBuffer.GetBuffer();
            if (length > 0 && bytes[length - 1] == (byte)'\r')
                length--;
            var line = _encoding.GetString(bytes, 0, length);
            _lineBuffer.SetLength(0);
            return line;
        }
    }
}
