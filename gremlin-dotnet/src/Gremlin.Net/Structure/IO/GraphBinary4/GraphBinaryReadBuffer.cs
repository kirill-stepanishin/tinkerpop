#region License

/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

#endregion

using System;
using System.Buffers.Binary;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Gremlin.Net.Structure.IO.GraphBinary4
{
    /// <summary>
    ///     A read-only buffering <see cref="Stream"/> used to deserialize a single GraphBinary 4.0 response.
    ///     It replaces the previous <c>BufferedStream(stream, 8192)</c> and additionally exposes zero-copy,
    ///     non-async-on-hit primitive readers so the common fixed-width read allocates nothing.
    ///
    ///     Lifetime / concurrency assumption: exactly one instance is created per response inside
    ///     <see cref="ResponseSerializer.ReadStreamingAsync"/>, and that response is deserialized by a
    ///     single background reader task (see <c>Connection.SubmitAsync</c>). A given instance is therefore
    ///     touched by exactly one thread at a time and never shared across concurrent responses, which is
    ///     why the internal buffer needs no locks, no <c>[ThreadStatic]</c>, and no detach protocol.
    ///
    ///     The underlying stream is NOT owned by this class — it belongs to the
    ///     <c>StreamingResponseContext</c> — so <see cref="Dispose(bool)"/>/<see cref="DisposeAsync"/> must
    ///     not dispose it.
    /// </summary>
    internal sealed class GraphBinaryReadBuffer : Stream
    {
        private const int DefaultBufferSize = 8192;

        private readonly Stream _stream;
        private readonly byte[] _buffer;

        // Buffer invariant: the unconsumed (already-read-from-the-underlying-stream but not-yet-served)
        // bytes are exactly _buffer[_start.._end). Reads advance _start; when _start == _end the buffer
        // is empty and a refill is needed. Refill()/RefillAsync() reset _start = 0 and set _end to the
        // number of bytes just read (0 signals end of the underlying stream). Always 0 <= _start <= _end.
        private int _start;
        private int _end;

        /// <summary>
        ///     Initializes a new instance of the <see cref="GraphBinaryReadBuffer"/> class wrapping the given
        ///     underlying stream, using the default 8192-byte buffer.
        /// </summary>
        /// <param name="stream">The underlying stream to read from. Not owned by this instance.</param>
        internal GraphBinaryReadBuffer(Stream stream) : this(stream, DefaultBufferSize)
        {
        }

        /// <summary>
        ///     Initializes a new instance of the <see cref="GraphBinaryReadBuffer"/> class wrapping the given
        ///     underlying stream, using a buffer of the given size. The size overload exists mainly so tests
        ///     can force tiny buffers and frequent refills.
        /// </summary>
        /// <param name="stream">The underlying stream to read from. Not owned by this instance.</param>
        /// <param name="bufferSize">The size of the internal read buffer in bytes.</param>
        internal GraphBinaryReadBuffer(Stream stream, int bufferSize)
        {
            _stream = stream ?? throw new ArgumentNullException(nameof(stream));
            if (bufferSize <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(bufferSize));
            }
            _buffer = new byte[bufferSize];
        }

        /// <inheritdoc />
        public override bool CanRead => true;

        /// <inheritdoc />
        public override bool CanWrite => false;

        /// <inheritdoc />
        public override bool CanSeek => false;

        /// <inheritdoc />
        public override long Length => throw new NotSupportedException();

        /// <inheritdoc />
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        /// <inheritdoc />
        public override void Flush()
        {
        }

        /// <inheritdoc />
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        /// <inheritdoc />
        public override void SetLength(long value) => throw new NotSupportedException();

        /// <inheritdoc />
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        // --- General read side (serve from the internal buffer, refill from the underlying stream) ---

        /// <inheritdoc />
        public override int Read(byte[] buffer, int offset, int count)
        {
            return Read(buffer.AsSpan(offset, count));
        }

        /// <inheritdoc />
        public override int Read(Span<byte> buffer)
        {
            if (buffer.Length == 0)
            {
                return 0;
            }

            if (_start >= _end)
            {
                Refill();
                if (_start >= _end)
                {
                    return 0;
                }
            }

            var available = _end - _start;
            var toCopy = Math.Min(available, buffer.Length);
            _buffer.AsSpan(_start, toCopy).CopyTo(buffer);
            _start += toCopy;
            return toCopy;
        }

        /// <inheritdoc />
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count,
            CancellationToken cancellationToken)
        {
            return ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        }

        /// <inheritdoc />
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            if (buffer.Length == 0)
            {
                return 0;
            }

            if (_start >= _end)
            {
                await RefillAsync(cancellationToken).ConfigureAwait(false);
                if (_start >= _end)
                {
                    return 0;
                }
            }

            var available = _end - _start;
            var toCopy = Math.Min(available, buffer.Length);
            _buffer.AsSpan(_start, toCopy).CopyTo(buffer.Span);
            _start += toCopy;
            return toCopy;
        }

        private void Refill()
        {
            // Read into a local first and commit _start/_end only on success, so a throwing
            // underlying read leaves the buffer invariant intact rather than in a state that
            // would replay already-consumed bytes.
            var bytesRead = _stream.Read(_buffer, 0, _buffer.Length);
            _start = 0;
            _end = bytesRead;
        }

        private async ValueTask RefillAsync(CancellationToken cancellationToken)
        {
            // See Refill(): commit _start/_end only after the read completes successfully.
            var bytesRead = await _stream.ReadAsync(_buffer.AsMemory(0, _buffer.Length), cancellationToken)
                .ConfigureAwait(false);
            _start = 0;
            _end = bytesRead;
        }

        // --- Zero-copy primitive readers ---

        /// <summary>
        ///     Reads a single <see cref="byte"/>, serving it directly from the internal buffer when available.
        ///     Throws <see cref="IOException"/> on end of stream, matching the existing read contract.
        /// </summary>
        internal ValueTask<byte> ReadByteValueAsync(CancellationToken cancellationToken = default)
        {
            if (_end - _start >= 1)
            {
                var value = _buffer[_start];
                _start += 1;
                return new ValueTask<byte>(value);
            }

            return ReadByteValueSlowAsync(cancellationToken);
        }

        private async ValueTask<byte> ReadByteValueSlowAsync(CancellationToken cancellationToken)
        {
            var local = new byte[1];
            var bytesRead = await ReadAsync(local.AsMemory(0, 1), cancellationToken).ConfigureAwait(false);
            if (bytesRead == 0)
            {
                throw new IOException("Unexpected end of stream");
            }
            return local[0];
        }

        /// <summary>
        ///     Reads a big-endian <see cref="int"/>, serving it directly from the internal buffer when available.
        /// </summary>
        // On end of stream (fewer than 4 bytes remaining) the slow path throws EndOfStreamException
        // (a subclass of IOException) via ReadExactlyAsync, matching the read contract.
        internal ValueTask<int> ReadIntValueAsync(CancellationToken cancellationToken = default)
        {
            if (_end - _start >= 4)
            {
                var value = BinaryPrimitives.ReadInt32BigEndian(_buffer.AsSpan(_start, 4));
                _start += 4;
                return new ValueTask<int>(value);
            }

            return ReadIntValueSlowAsync(cancellationToken);
        }

        private async ValueTask<int> ReadIntValueSlowAsync(CancellationToken cancellationToken)
        {
            var local = new byte[4];
            await this.ReadExactlyAsync(local, 0, 4, cancellationToken).ConfigureAwait(false);
            return BinaryPrimitives.ReadInt32BigEndian(local);
        }

        /// <summary>
        ///     Reads a big-endian <see cref="long"/>, serving it directly from the internal buffer when available.
        /// </summary>
        // On end of stream (fewer than 8 bytes remaining) the slow path throws EndOfStreamException
        // (a subclass of IOException) via ReadExactlyAsync, matching the read contract.
        internal ValueTask<long> ReadLongValueAsync(CancellationToken cancellationToken = default)
        {
            if (_end - _start >= 8)
            {
                var value = BinaryPrimitives.ReadInt64BigEndian(_buffer.AsSpan(_start, 8));
                _start += 8;
                return new ValueTask<long>(value);
            }

            return ReadLongValueSlowAsync(cancellationToken);
        }

        private async ValueTask<long> ReadLongValueSlowAsync(CancellationToken cancellationToken)
        {
            var local = new byte[8];
            await this.ReadExactlyAsync(local, 0, 8, cancellationToken).ConfigureAwait(false);
            return BinaryPrimitives.ReadInt64BigEndian(local);
        }

        /// <summary>
        ///     Reads a big-endian <see cref="short"/>, serving it directly from the internal buffer when available.
        /// </summary>
        // On end of stream (fewer than 2 bytes remaining) the slow path throws EndOfStreamException
        // (a subclass of IOException) via ReadExactlyAsync, matching the read contract.
        internal ValueTask<short> ReadShortValueAsync(CancellationToken cancellationToken = default)
        {
            if (_end - _start >= 2)
            {
                var value = BinaryPrimitives.ReadInt16BigEndian(_buffer.AsSpan(_start, 2));
                _start += 2;
                return new ValueTask<short>(value);
            }

            return ReadShortValueSlowAsync(cancellationToken);
        }

        private async ValueTask<short> ReadShortValueSlowAsync(CancellationToken cancellationToken)
        {
            var local = new byte[2];
            await this.ReadExactlyAsync(local, 0, 2, cancellationToken).ConfigureAwait(false);
            return BinaryPrimitives.ReadInt16BigEndian(local);
        }

        /// <summary>
        ///     Reads a big-endian <see cref="float"/>, serving it directly from the internal buffer when available.
        /// </summary>
        // On end of stream (fewer than 4 bytes remaining) the slow path throws EndOfStreamException
        // (a subclass of IOException) via ReadExactlyAsync, matching the read contract.
        internal ValueTask<float> ReadFloatValueAsync(CancellationToken cancellationToken = default)
        {
            if (_end - _start >= 4)
            {
                var value = BinaryPrimitives.ReadSingleBigEndian(_buffer.AsSpan(_start, 4));
                _start += 4;
                return new ValueTask<float>(value);
            }

            return ReadFloatValueSlowAsync(cancellationToken);
        }

        private async ValueTask<float> ReadFloatValueSlowAsync(CancellationToken cancellationToken)
        {
            var local = new byte[4];
            await this.ReadExactlyAsync(local, 0, 4, cancellationToken).ConfigureAwait(false);
            return BinaryPrimitives.ReadSingleBigEndian(local);
        }

        /// <summary>
        ///     Reads a big-endian <see cref="double"/>, serving it directly from the internal buffer when available.
        /// </summary>
        // On end of stream (fewer than 8 bytes remaining) the slow path throws EndOfStreamException
        // (a subclass of IOException) via ReadExactlyAsync, matching the read contract.
        internal ValueTask<double> ReadDoubleValueAsync(CancellationToken cancellationToken = default)
        {
            if (_end - _start >= 8)
            {
                var value = BinaryPrimitives.ReadDoubleBigEndian(_buffer.AsSpan(_start, 8));
                _start += 8;
                return new ValueTask<double>(value);
            }

            return ReadDoubleValueSlowAsync(cancellationToken);
        }

        private async ValueTask<double> ReadDoubleValueSlowAsync(CancellationToken cancellationToken)
        {
            var local = new byte[8];
            await this.ReadExactlyAsync(local, 0, 8, cancellationToken).ConfigureAwait(false);
            return BinaryPrimitives.ReadDoubleBigEndian(local);
        }

        /// <inheritdoc />
        protected override void Dispose(bool disposing)
        {
            // Intentionally does NOT dispose the underlying stream — it is owned by
            // StreamingResponseContext. Nothing else to release here.
        }

        /// <inheritdoc />
        public override ValueTask DisposeAsync()
        {
            // Intentionally does NOT dispose the underlying stream — see Dispose(bool).
            return ValueTask.CompletedTask;
        }
    }
}
