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
    ///     Provides extension methods for <see cref="Stream" /> that are mostly useful when implementing GraphBinary
    ///     serializers.
    /// </summary>
    public static class StreamExtensions
    {
        // Per-thread scratch buffer (max primitive width is 8 bytes) used to avoid a per-call
        // heap allocation on the synchronous "buffer hit" hot path.
        //
        // Load-bearing invariant: the synchronous fast path must never `await` between acquiring
        // `buf` and parsing it — otherwise another logical flow could be scheduled onto this thread
        // and write into the shared buffer. Only the async-miss path awaits, and it detaches
        // (`_scratch = null`) first: the pending ValueTask keeps the array privately, so a reentrant
        // read on this pool thread lazily allocates a fresh buffer instead of clobbering the
        // in-flight one. This is the authoritative explanation; the per-method `_scratch = null`
        // sites refer back here.
        [ThreadStatic] private static byte[]? _scratch;

        /// <summary>
        ///     Asynchronously writes a <see cref="byte"/> to a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to write the <see cref="byte"/> to.</param>
        /// <param name="value">The <see cref="byte"/> to write.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        public static async Task WriteByteAsync(this Stream stream, byte value,
            CancellationToken cancellationToken = default)
        {
            await stream.WriteAsync(new[] {value}, 0, 1, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        ///     Asynchronously reads a <see cref="byte"/> from a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to read from.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        /// <returns>The read <see cref="byte"/>.</returns>
        public static ValueTask<byte> ReadByteAsync(this Stream stream,
            CancellationToken cancellationToken = default)
        {
            var buf = _scratch ??= new byte[8];
            var read = stream.ReadAsync(buf.AsMemory(0, 1), cancellationToken);
            if (read.IsCompletedSuccessfully)
            {
                if (read.Result == 0)
                {
                    throw new IOException("Unexpected end of stream");
                }
                return new ValueTask<byte>(buf[0]);
            }

            // async miss: `read` is bound to `buf`. Detach the shared buffer (see `_scratch`) so a
            // reentrant read on this thread lazily allocates a fresh one instead of writing into
            // our in-flight buffer; then await our pending read on the now-private array.
            _scratch = null;
            return AwaitByteAsync(read, buf);
        }

        private static async ValueTask<byte> AwaitByteAsync(ValueTask<int> pending, byte[] buf)
        {
            var bytesRead = await pending.ConfigureAwait(false);
            if (bytesRead == 0)
            {
                throw new IOException("Unexpected end of stream");
            }
            return buf[0];
        }

        /// <summary>
        ///     Asynchronously writes a <see cref="sbyte"/> to a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to write the <see cref="sbyte"/> to.</param>
        /// <param name="value">The <see cref="sbyte"/> to write.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        public static async Task WriteSByteAsync(this Stream stream, sbyte value,
            CancellationToken cancellationToken = default)
        {
            await stream.WriteByteAsync((byte)value, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        ///     Asynchronously reads a <see cref="sbyte"/> from a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to read from.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        /// <returns>The read <see cref="sbyte"/>.</returns>
        public static async ValueTask<sbyte> ReadSByteAsync(this Stream stream,
            CancellationToken cancellationToken = default)
        {
            return (sbyte)await stream.ReadByteAsync(cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        ///     Asynchronously writes an <see cref="int"/> to a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to write the <see cref="int"/> to.</param>
        /// <param name="value">The <see cref="int"/> to write.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        public static async Task WriteIntAsync(this Stream stream, int value,
            CancellationToken cancellationToken = default)
        {
            var bytes = new byte[4];
            BinaryPrimitives.WriteInt32BigEndian(bytes, value);
            await stream.WriteAsync(bytes, 0, 4, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        ///     Asynchronously reads an <see cref="int"/> from a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to read from.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        /// <returns>The read <see cref="int"/>.</returns>
        public static ValueTask<int> ReadIntAsync(this Stream stream,
            CancellationToken cancellationToken = default)
        {
            var buf = _scratch ??= new byte[8];
            var read = stream.ReadAsync(buf.AsMemory(0, 4), cancellationToken);
            if (read.IsCompletedSuccessfully)
            {
                var n = read.Result;
                if (n == 4)
                {
                    return new ValueTask<int>(BinaryPrimitives.ReadInt32BigEndian(buf.AsSpan(0, 4)));
                }

                // sync partial read (rare; e.g. at a BufferedStream refill boundary, or any stream
                // that returns fewer bytes than requested): buffer done, continue on a private local.
                var partial = new byte[4];
                buf.AsSpan(0, n).CopyTo(partial);
                return FinishIntAsync(stream, partial, n, cancellationToken);
            }

            // async miss: `read` is bound to `buf`. Detach the shared buffer (see `_scratch`) so a
            // reentrant read on this thread lazily allocates a fresh one instead of writing into
            // our in-flight buffer; then await our pending read on the now-private array.
            _scratch = null;
            return AwaitIntAsync(read, buf, stream, cancellationToken);
        }

        private static async ValueTask<int> AwaitIntAsync(ValueTask<int> pending, byte[] buf,
            Stream stream, CancellationToken cancellationToken)
        {
            var n = await pending.ConfigureAwait(false);
            if (n < 4)
            {
                await stream.ReadExactlyAsync(buf, n, 4 - n, cancellationToken).ConfigureAwait(false);
            }
            return BinaryPrimitives.ReadInt32BigEndian(buf.AsSpan(0, 4));
        }

        private static async ValueTask<int> FinishIntAsync(Stream stream, byte[] buf, int alreadyRead,
            CancellationToken cancellationToken)
        {
            await stream.ReadExactlyAsync(buf, alreadyRead, 4 - alreadyRead, cancellationToken)
                .ConfigureAwait(false);
            return BinaryPrimitives.ReadInt32BigEndian(buf);
        }

        /// <summary>
        ///     Asynchronously writes a <see cref="long"/> to a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to write the <see cref="long"/> to.</param>
        /// <param name="value">The <see cref="long"/> to write.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        public static async Task WriteLongAsync(this Stream stream, long value,
            CancellationToken cancellationToken = default)
        {
            var bytes = new byte[8];
            BinaryPrimitives.WriteInt64BigEndian(bytes, value);
            await stream.WriteAsync(bytes, 0, 8, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        ///     Asynchronously reads a <see cref="long"/> from a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to read from.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        /// <returns>The read <see cref="long"/>.</returns>
        public static ValueTask<long> ReadLongAsync(this Stream stream,
            CancellationToken cancellationToken = default)
        {
            var buf = _scratch ??= new byte[8];
            var read = stream.ReadAsync(buf.AsMemory(0, 8), cancellationToken);
            if (read.IsCompletedSuccessfully)
            {
                var n = read.Result;
                if (n == 8)
                {
                    return new ValueTask<long>(BinaryPrimitives.ReadInt64BigEndian(buf.AsSpan(0, 8)));
                }

                var partial = new byte[8];
                buf.AsSpan(0, n).CopyTo(partial);
                return FinishLongAsync(stream, partial, n, cancellationToken);
            }

            // async miss: `read` is bound to `buf`. Detach the shared buffer (see `_scratch`) so a
            // reentrant read on this thread lazily allocates a fresh one; then await on the now-private array.
            _scratch = null;
            return AwaitLongAsync(read, buf, stream, cancellationToken);
        }

        private static async ValueTask<long> AwaitLongAsync(ValueTask<int> pending, byte[] buf,
            Stream stream, CancellationToken cancellationToken)
        {
            var n = await pending.ConfigureAwait(false);
            if (n < 8)
            {
                await stream.ReadExactlyAsync(buf, n, 8 - n, cancellationToken).ConfigureAwait(false);
            }
            return BinaryPrimitives.ReadInt64BigEndian(buf.AsSpan(0, 8));
        }

        private static async ValueTask<long> FinishLongAsync(Stream stream, byte[] buf, int alreadyRead,
            CancellationToken cancellationToken)
        {
            await stream.ReadExactlyAsync(buf, alreadyRead, 8 - alreadyRead, cancellationToken)
                .ConfigureAwait(false);
            return BinaryPrimitives.ReadInt64BigEndian(buf);
        }

        /// <summary>
        ///     Asynchronously writes a <see cref="float"/> to a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to write the <see cref="float"/> to.</param>
        /// <param name="value">The <see cref="float"/> to write.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        public static async Task WriteFloatAsync(this Stream stream, float value,
            CancellationToken cancellationToken = default)
        {
            var bytes = new byte[4];
            BinaryPrimitives.WriteSingleBigEndian(bytes, value);
            await stream.WriteAsync(bytes, 0, 4, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        ///     Asynchronously reads a <see cref="float"/> from a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to read from.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        /// <returns>The read <see cref="float"/>.</returns>
        public static ValueTask<float> ReadFloatAsync(this Stream stream,
            CancellationToken cancellationToken = default)
        {
            var buf = _scratch ??= new byte[8];
            var read = stream.ReadAsync(buf.AsMemory(0, 4), cancellationToken);
            if (read.IsCompletedSuccessfully)
            {
                var n = read.Result;
                if (n == 4)
                {
                    return new ValueTask<float>(BinaryPrimitives.ReadSingleBigEndian(buf.AsSpan(0, 4)));
                }

                var partial = new byte[4];
                buf.AsSpan(0, n).CopyTo(partial);
                return FinishFloatAsync(stream, partial, n, cancellationToken);
            }

            // async miss: `read` is bound to `buf`. Detach the shared buffer (see `_scratch`) so a
            // reentrant read on this thread lazily allocates a fresh one; then await on the now-private array.
            _scratch = null;
            return AwaitFloatAsync(read, buf, stream, cancellationToken);
        }

        private static async ValueTask<float> AwaitFloatAsync(ValueTask<int> pending, byte[] buf,
            Stream stream, CancellationToken cancellationToken)
        {
            var n = await pending.ConfigureAwait(false);
            if (n < 4)
            {
                await stream.ReadExactlyAsync(buf, n, 4 - n, cancellationToken).ConfigureAwait(false);
            }
            return BinaryPrimitives.ReadSingleBigEndian(buf.AsSpan(0, 4));
        }

        private static async ValueTask<float> FinishFloatAsync(Stream stream, byte[] buf, int alreadyRead,
            CancellationToken cancellationToken)
        {
            await stream.ReadExactlyAsync(buf, alreadyRead, 4 - alreadyRead, cancellationToken)
                .ConfigureAwait(false);
            return BinaryPrimitives.ReadSingleBigEndian(buf);
        }

        /// <summary>
        ///     Asynchronously writes a <see cref="double"/> to a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to write the <see cref="double"/> to.</param>
        /// <param name="value">The <see cref="double"/> to write.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        public static async Task WriteDoubleAsync(this Stream stream, double value,
            CancellationToken cancellationToken = default)
        {
            var bytes = new byte[8];
            BinaryPrimitives.WriteDoubleBigEndian(bytes, value);
            await stream.WriteAsync(bytes, 0, 8, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        ///     Asynchronously reads a <see cref="double"/> from a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to read from.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        /// <returns>The read <see cref="double"/>.</returns>
        public static ValueTask<double> ReadDoubleAsync(this Stream stream,
            CancellationToken cancellationToken = default)
        {
            var buf = _scratch ??= new byte[8];
            var read = stream.ReadAsync(buf.AsMemory(0, 8), cancellationToken);
            if (read.IsCompletedSuccessfully)
            {
                var n = read.Result;
                if (n == 8)
                {
                    return new ValueTask<double>(BinaryPrimitives.ReadDoubleBigEndian(buf.AsSpan(0, 8)));
                }

                var partial = new byte[8];
                buf.AsSpan(0, n).CopyTo(partial);
                return FinishDoubleAsync(stream, partial, n, cancellationToken);
            }

            // async miss: `read` is bound to `buf`. Detach the shared buffer (see `_scratch`) so a
            // reentrant read on this thread lazily allocates a fresh one; then await on the now-private array.
            _scratch = null;
            return AwaitDoubleAsync(read, buf, stream, cancellationToken);
        }

        private static async ValueTask<double> AwaitDoubleAsync(ValueTask<int> pending, byte[] buf,
            Stream stream, CancellationToken cancellationToken)
        {
            var n = await pending.ConfigureAwait(false);
            if (n < 8)
            {
                await stream.ReadExactlyAsync(buf, n, 8 - n, cancellationToken).ConfigureAwait(false);
            }
            return BinaryPrimitives.ReadDoubleBigEndian(buf.AsSpan(0, 8));
        }

        private static async ValueTask<double> FinishDoubleAsync(Stream stream, byte[] buf, int alreadyRead,
            CancellationToken cancellationToken)
        {
            await stream.ReadExactlyAsync(buf, alreadyRead, 8 - alreadyRead, cancellationToken)
                .ConfigureAwait(false);
            return BinaryPrimitives.ReadDoubleBigEndian(buf);
        }

        /// <summary>
        ///     Asynchronously writes a <see cref="short"/> to a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to write the <see cref="short"/> to.</param>
        /// <param name="value">The <see cref="short"/> to write.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        public static async Task WriteShortAsync(this Stream stream, short value,
            CancellationToken cancellationToken = default)
        {
            var bytes = new byte[2];
            BinaryPrimitives.WriteInt16BigEndian(bytes, value);
            await stream.WriteAsync(bytes, 0, 2, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        ///     Asynchronously reads a <see cref="short"/> from a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to read from.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        /// <returns>The read <see cref="short"/>.</returns>
        public static ValueTask<short> ReadShortAsync(this Stream stream,
            CancellationToken cancellationToken = default)
        {
            var buf = _scratch ??= new byte[8];
            var read = stream.ReadAsync(buf.AsMemory(0, 2), cancellationToken);
            if (read.IsCompletedSuccessfully)
            {
                var n = read.Result;
                if (n == 2)
                {
                    return new ValueTask<short>(BinaryPrimitives.ReadInt16BigEndian(buf.AsSpan(0, 2)));
                }

                var partial = new byte[2];
                buf.AsSpan(0, n).CopyTo(partial);
                return FinishShortAsync(stream, partial, n, cancellationToken);
            }

            // async miss: `read` is bound to `buf`. Detach the shared buffer (see `_scratch`) so a
            // reentrant read on this thread lazily allocates a fresh one; then await on the now-private array.
            _scratch = null;
            return AwaitShortAsync(read, buf, stream, cancellationToken);
        }

        private static async ValueTask<short> AwaitShortAsync(ValueTask<int> pending, byte[] buf,
            Stream stream, CancellationToken cancellationToken)
        {
            var n = await pending.ConfigureAwait(false);
            if (n < 2)
            {
                await stream.ReadExactlyAsync(buf, n, 2 - n, cancellationToken).ConfigureAwait(false);
            }
            return BinaryPrimitives.ReadInt16BigEndian(buf.AsSpan(0, 2));
        }

        private static async ValueTask<short> FinishShortAsync(Stream stream, byte[] buf, int alreadyRead,
            CancellationToken cancellationToken)
        {
            await stream.ReadExactlyAsync(buf, alreadyRead, 2 - alreadyRead, cancellationToken)
                .ConfigureAwait(false);
            return BinaryPrimitives.ReadInt16BigEndian(buf);
        }

        /// <summary>
        ///     Asynchronously writes a <see cref="bool"/> to a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to write the <see cref="bool"/> to.</param>
        /// <param name="value">The <see cref="bool"/> to write.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        public static async Task WriteBoolAsync(this Stream stream, bool value,
            CancellationToken cancellationToken = default)
        {
            await stream.WriteByteAsync((byte)(value ? 1 : 0), cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        ///     Asynchronously reads a <see cref="bool"/> from a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to read from.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        /// <returns>The read <see cref="bool"/>.</returns>
        public static async ValueTask<bool> ReadBoolAsync(this Stream stream,
            CancellationToken cancellationToken = default)
        {
            var b = await stream.ReadByteAsync(cancellationToken).ConfigureAwait(false);
            return b switch
            {
                1 => true,
                0 => false,
                _ => throw new IOException($"Cannot read byte {b} as a boolean.")
            };
        }

        /// <summary>
        ///     Asynchronously writes a <see cref="T:byte[]"/> to a <see cref="Stream"/>.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to write the <see cref="T:byte[]"/> to.</param>
        /// <param name="value">The <see cref="T:byte[]"/> to write.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        public static async Task WriteAsync(this Stream stream, byte[] value,
            CancellationToken cancellationToken = default)
        {
            await stream.WriteAsync(value, 0, value.Length, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        ///     Asynchronously reads a <see cref="T:byte[]"/> from a <see cref="Stream"/> into a buffer.
        /// </summary>
        /// <param name="stream">The <see cref="Stream"/> to read from.</param>
        /// <param name="count">The number of bytes to read.</param>
        /// <param name="cancellationToken">The token to cancel the operation. The default value is None.</param>
        /// <returns>The read <see cref="T:byte[]"/>.</returns>
        public static async ValueTask<byte[]> ReadAsync(this Stream stream, int count,
            CancellationToken cancellationToken = default)
        {
            var buffer = new byte[count];
            await stream.ReadExactlyAsync(buffer, 0, count, cancellationToken).ConfigureAwait(false);
            return buffer;
        }
    }
}
