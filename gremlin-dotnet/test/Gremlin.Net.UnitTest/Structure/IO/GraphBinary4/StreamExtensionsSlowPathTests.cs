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
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Gremlin.Net.Structure.IO.GraphBinary4;
using Xunit;

namespace Gremlin.Net.UnitTest.Structure.IO.GraphBinary4
{
    /// <summary>
    ///     Exercises the slow/partial/async completion paths of the GraphBinary read extension
    ///     methods that a plain <see cref="MemoryStream"/> never triggers (it always completes
    ///     synchronously and returns every requested byte at once).
    /// </summary>
    public class StreamExtensionsSlowPathTests
    {
        // --- Test doubles -------------------------------------------------------------------

        /// <summary>
        ///     A stream that returns at most <c>chunkSize</c> bytes per <see cref="ReadAsync(Memory{byte},CancellationToken)"/>
        ///     call and always completes ASYNCHRONOUSLY (via <see cref="Task.Yield"/>), forcing the
        ///     detach/await slow path. All synchronous / legacy read entry points throw to prove they
        ///     are never used.
        /// </summary>
        private sealed class DripStream : Stream
        {
            private readonly byte[] _data;
            private readonly int _chunkSize;
            private int _pos;

            public DripStream(byte[] data, int chunkSize)
            {
                _data = data;
                _chunkSize = chunkSize;
            }

            public override async ValueTask<int> ReadAsync(Memory<byte> buffer,
                CancellationToken cancellationToken = default)
            {
                await Task.Yield(); // guarantees IsCompletedSuccessfully == false at the call site
                cancellationToken.ThrowIfCancellationRequested();
                var remaining = _data.Length - _pos;
                if (remaining <= 0)
                {
                    return 0;
                }
                var toCopy = Math.Min(Math.Min(_chunkSize, buffer.Length), remaining);
                _data.AsSpan(_pos, toCopy).CopyTo(buffer.Span);
                _pos += toCopy;
                return toCopy;
            }

            public override int Read(byte[] buffer, int offset, int count) =>
                throw new InvalidOperationException("Synchronous Read must not be used.");

            public override Task<int> ReadAsync(byte[] buffer, int offset, int count,
                CancellationToken cancellationToken) =>
                throw new InvalidOperationException("Legacy array ReadAsync must not be used.");

            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => _data.Length;
            public override long Position { get => _pos; set => throw new NotSupportedException(); }
            public override void Flush() { }
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }

        /// <summary>
        ///     A stream that returns at most <c>chunkSize</c> bytes per call but completes
        ///     SYNCHRONOUSLY (returns a completed <see cref="ValueTask{Int32}"/>), forcing the
        ///     sync-partial (<c>FinishXAsync</c>) branch. Synchronous / legacy paths throw.
        /// </summary>
        private sealed class SyncPartialStream : Stream
        {
            private readonly byte[] _data;
            private readonly int _chunkSize;
            private int _pos;

            public SyncPartialStream(byte[] data, int chunkSize)
            {
                _data = data;
                _chunkSize = chunkSize;
            }

            public override ValueTask<int> ReadAsync(Memory<byte> buffer,
                CancellationToken cancellationToken = default)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var remaining = _data.Length - _pos;
                if (remaining <= 0)
                {
                    return new ValueTask<int>(0);
                }
                var toCopy = Math.Min(Math.Min(_chunkSize, buffer.Length), remaining);
                _data.AsSpan(_pos, toCopy).CopyTo(buffer.Span);
                _pos += toCopy;
                return new ValueTask<int>(toCopy); // completed synchronously
            }

            public override int Read(byte[] buffer, int offset, int count) =>
                throw new InvalidOperationException("Synchronous Read must not be used.");

            public override Task<int> ReadAsync(byte[] buffer, int offset, int count,
                CancellationToken cancellationToken) =>
                throw new InvalidOperationException("Legacy array ReadAsync must not be used.");

            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => _data.Length;
            public override long Position { get => _pos; set => throw new NotSupportedException(); }
            public override void Flush() { }
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }

        /// <summary>
        ///     A stream whose <see cref="ReadAsync(Memory{byte},CancellationToken)"/> never returns
        ///     data; it waits on the supplied token so a mid-read cancellation can be triggered.
        /// </summary>
        private sealed class StallingStream : Stream
        {
            public override async ValueTask<int> ReadAsync(Memory<byte> buffer,
                CancellationToken cancellationToken = default)
            {
                // Block until cancelled; this throws OperationCanceledException on cancel.
                await Task.Delay(Timeout.Infinite, cancellationToken).ConfigureAwait(false);
                return 0; // unreachable
            }

            public override int Read(byte[] buffer, int offset, int count) =>
                throw new InvalidOperationException("Synchronous Read must not be used.");

            public override Task<int> ReadAsync(byte[] buffer, int offset, int count,
                CancellationToken cancellationToken) =>
                throw new InvalidOperationException("Legacy array ReadAsync must not be used.");

            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => throw new NotSupportedException();
            public override long Position { get => 0; set => throw new NotSupportedException(); }
            public override void Flush() { }
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }

        /// <summary>
        ///     A stream whose first <see cref="ReadAsync(Memory{byte},CancellationToken)"/> does not
        ///     complete until an external gate (a <see cref="TaskCompletionSource{TResult}"/>) is
        ///     released. This lets a test hold multiple reads pending on the shared <c>_scratch</c>
        ///     buffer at once, then release them in a controlled order. Signals when its first read
        ///     has been issued so the test can deterministically interleave a second read.
        /// </summary>
        private sealed class GatedStream : Stream
        {
            private readonly byte[] _data;
            private readonly TaskCompletionSource<bool> _gate;
            private readonly TaskCompletionSource<bool> _issued =
                new(TaskCreationOptions.RunContinuationsAsynchronously);
            private int _pos;
            private bool _firstReadSeen;

            public GatedStream(byte[] data, TaskCompletionSource<bool> gate)
            {
                _data = data;
                _gate = gate;
            }

            /// <summary>Completes once this stream's first <c>ReadAsync</c> has been issued.</summary>
            public Task FirstReadIssued => _issued.Task;

            public override async ValueTask<int> ReadAsync(Memory<byte> buffer,
                CancellationToken cancellationToken = default)
            {
                if (!_firstReadSeen)
                {
                    _firstReadSeen = true;
                    _issued.TrySetResult(true);
                    // Await the gate so this first read stays pending (async, not completed),
                    // forcing the detach/await slow path and holding _scratch in flight.
                    await _gate.Task.ConfigureAwait(false);
                }
                else
                {
                    await Task.Yield();
                }

                cancellationToken.ThrowIfCancellationRequested();
                var remaining = _data.Length - _pos;
                if (remaining <= 0)
                {
                    return 0;
                }
                // Drip one byte per call so reassembly spans several awaits.
                var toCopy = Math.Min(Math.Min(1, buffer.Length), remaining);
                _data.AsSpan(_pos, toCopy).CopyTo(buffer.Span);
                _pos += toCopy;
                return toCopy;
            }

            public override int Read(byte[] buffer, int offset, int count) =>
                throw new InvalidOperationException("Synchronous Read must not be used.");

            public override Task<int> ReadAsync(byte[] buffer, int offset, int count,
                CancellationToken cancellationToken) =>
                throw new InvalidOperationException("Legacy array ReadAsync must not be used.");

            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => _data.Length;
            public override long Position { get => _pos; set => throw new NotSupportedException(); }
            public override void Flush() { }
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }

        // --- Case 1: async 1-byte-at-a-time reassembly per method ---------------------------

        [Fact]
        public async Task ReadByteAsyncShouldReassembleWhenDripFedAsync()
        {
            var stream = new DripStream(new byte[] { 0xAB }, chunkSize: 1);

            var result = await stream.ReadByteAsync();

            Assert.Equal(0xAB, result);
        }

        [Fact]
        public async Task ReadIntAsyncShouldReassembleWhenDripFedAsync()
        {
            var stream = new DripStream(new byte[] { 0x01, 0x02, 0x03, 0x04 }, chunkSize: 1);

            var result = await stream.ReadIntAsync();

            Assert.Equal(0x01020304, result);
        }

        [Fact]
        public async Task ReadLongAsyncShouldReassembleWhenDripFedAsync()
        {
            var stream = new DripStream(
                new byte[] { 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08 }, chunkSize: 1);

            var result = await stream.ReadLongAsync();

            Assert.Equal(0x0102030405060708L, result);
        }

        [Fact]
        public async Task ReadShortAsyncShouldReassembleWhenDripFedAsync()
        {
            var stream = new DripStream(new byte[] { 0x01, 0x02 }, chunkSize: 1);

            var result = await stream.ReadShortAsync();

            Assert.Equal((short)0x0102, result);
        }

        [Fact]
        public async Task ReadFloatAsyncShouldReassembleWhenDripFedAsync()
        {
            var stream = new DripStream(new byte[] { 0x3F, 0x80, 0x00, 0x00 }, chunkSize: 1);

            var result = await stream.ReadFloatAsync();

            Assert.Equal(1.0f, result);
        }

        [Fact]
        public async Task ReadDoubleAsyncShouldReassembleWhenDripFedAsync()
        {
            var stream = new DripStream(
                new byte[] { 0x3F, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 }, chunkSize: 1);

            var result = await stream.ReadDoubleAsync();

            Assert.Equal(1.0d, result);
        }

        // --- Case 2: sync-partial reassembly (FinishXAsync branch) --------------------------

        [Fact]
        public async Task ReadIntAsyncShouldReassembleAcrossSyncPartialSplit()
        {
            var stream = new SyncPartialStream(new byte[] { 0x01, 0x02, 0x03, 0x04 }, chunkSize: 1);

            var result = await stream.ReadIntAsync();

            Assert.Equal(0x01020304, result);
        }

        [Fact]
        public async Task ReadLongAsyncShouldReassembleAcrossSyncPartialSplit()
        {
            var stream = new SyncPartialStream(
                new byte[] { 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08 }, chunkSize: 3);

            var result = await stream.ReadLongAsync();

            Assert.Equal(0x0102030405060708L, result);
        }

        [Fact]
        public async Task ReadShortAsyncShouldReassembleAcrossSyncPartialSplit()
        {
            var stream = new SyncPartialStream(new byte[] { 0x01, 0x02 }, chunkSize: 1);

            var result = await stream.ReadShortAsync();

            Assert.Equal((short)0x0102, result);
        }

        [Fact]
        public async Task ReadFloatAsyncShouldReassembleAcrossSyncPartialSplit()
        {
            var stream = new SyncPartialStream(new byte[] { 0x3F, 0x80, 0x00, 0x00 }, chunkSize: 2);

            var result = await stream.ReadFloatAsync();

            Assert.Equal(1.0f, result);
        }

        [Fact]
        public async Task ReadDoubleAsyncShouldReassembleAcrossSyncPartialSplit()
        {
            var stream = new SyncPartialStream(
                new byte[] { 0x3F, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 }, chunkSize: 5);

            var result = await stream.ReadDoubleAsync();

            Assert.Equal(1.0d, result);
        }

        // --- Case 3: short stream on the slow path -> correct exception type ----------------

        [Fact]
        public async Task ReadByteAsyncShouldThrowIOExceptionOnShortDripStream()
        {
            var stream = new DripStream(Array.Empty<byte>(), chunkSize: 1);

            await Assert.ThrowsAsync<IOException>(async () => await stream.ReadByteAsync());
        }

        [Fact]
        public async Task ReadIntAsyncShouldThrowEndOfStreamOnShortDripStream()
        {
            var stream = new DripStream(new byte[] { 0x01, 0x02, 0x03 }, chunkSize: 1);

            await Assert.ThrowsAsync<EndOfStreamException>(async () => await stream.ReadIntAsync());
        }

        [Fact]
        public async Task ReadLongAsyncShouldThrowEndOfStreamOnShortDripStream()
        {
            var stream = new DripStream(
                new byte[] { 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07 }, chunkSize: 1);

            await Assert.ThrowsAsync<EndOfStreamException>(async () => await stream.ReadLongAsync());
        }

        [Fact]
        public async Task ReadShortAsyncShouldThrowEndOfStreamOnShortDripStream()
        {
            var stream = new DripStream(new byte[] { 0x01 }, chunkSize: 1);

            await Assert.ThrowsAsync<EndOfStreamException>(async () => await stream.ReadShortAsync());
        }

        [Fact]
        public async Task ReadFloatAsyncShouldThrowEndOfStreamOnShortDripStream()
        {
            var stream = new DripStream(new byte[] { 0x01, 0x02, 0x03 }, chunkSize: 1);

            await Assert.ThrowsAsync<EndOfStreamException>(async () => await stream.ReadFloatAsync());
        }

        [Fact]
        public async Task ReadDoubleAsyncShouldThrowEndOfStreamOnShortDripStream()
        {
            var stream = new DripStream(
                new byte[] { 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07 }, chunkSize: 1);

            await Assert.ThrowsAsync<EndOfStreamException>(async () => await stream.ReadDoubleAsync());
        }

        [Fact]
        public async Task ReadIntAsyncShouldThrowEndOfStreamOnShortSyncPartialStream()
        {
            var stream = new SyncPartialStream(new byte[] { 0x01, 0x02, 0x03 }, chunkSize: 1);

            await Assert.ThrowsAsync<EndOfStreamException>(async () => await stream.ReadIntAsync());
        }

        // --- Case 4: cancellation mid slow-path ---------------------------------------------

        [Theory]
        [InlineData("byte")]
        [InlineData("int")]
        [InlineData("long")]
        [InlineData("short")]
        [InlineData("float")]
        [InlineData("double")]
        public async Task ReadShouldThrowOnCancellationMidSlowPath(string kind)
        {
            using var cts = new CancellationTokenSource();
            var stream = new StallingStream();

            var readTask = kind switch
            {
                "byte" => AwaitAsObject(stream.ReadByteAsync(cts.Token)),
                "int" => AwaitAsObject(stream.ReadIntAsync(cts.Token)),
                "long" => AwaitAsObject(stream.ReadLongAsync(cts.Token)),
                "short" => AwaitAsObject(stream.ReadShortAsync(cts.Token)),
                "float" => AwaitAsObject(stream.ReadFloatAsync(cts.Token)),
                "double" => AwaitAsObject(stream.ReadDoubleAsync(cts.Token)),
                _ => throw new ArgumentOutOfRangeException(nameof(kind))
            };

            cts.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await readTask);
        }

        private static async Task<object> AwaitAsObject<T>(ValueTask<T> valueTask)
        {
            return (await valueTask.ConfigureAwait(false))!;
        }

        // --- Case 5: reentrancy / concurrency sanity (guards the _scratch detach) ------------

        [Fact]
        public async Task ManyConcurrentDripFedReadsShouldNotCorruptSharedScratch()
        {
            const int count = 256;

            var tasks = Enumerable.Range(0, count).Select(i => Task.Run(async () =>
            {
                // Distinct big-endian long per task; drip-fed 1 byte at a time on the async path.
                long expected = 0x1122334400000000L + i;
                var bytes = new byte[8];
                System.Buffers.Binary.BinaryPrimitives.WriteInt64BigEndian(bytes, expected);
                var stream = new DripStream(bytes, chunkSize: 1);

                var actual = await stream.ReadLongAsync();
                Assert.Equal(expected, actual);
            })).ToArray();

            await Task.WhenAll(tasks);
        }

        [Fact]
        public async Task ManyConcurrentMixedWidthReadsShouldNotCorruptSharedScratch()
        {
            const int count = 256;

            var tasks = Enumerable.Range(0, count).Select(i => Task.Run(async () =>
            {
                var intStream = new DripStream(new byte[] { 0x01, 0x02, 0x03, 0x04 }, chunkSize: 1);
                var shortStream = new DripStream(new byte[] { 0x05, 0x06 }, chunkSize: 1);

                var intVal = await intStream.ReadIntAsync();
                var shortVal = await shortStream.ReadShortAsync();

                Assert.Equal(0x01020304, intVal);
                Assert.Equal((short)0x0506, shortVal);
            })).ToArray();

            await Task.WhenAll(tasks);
        }

        // --- Case 6: already-cancelled token, sync-completing stream ------------------------
        // The public entry points no longer call ThrowIfCancellationRequested themselves; the
        // token is honored solely by flowing it into stream.ReadAsync. A SyncPartialStream would
        // complete synchronously and could bypass cancellation, so these prove the token is still
        // observed even when the underlying read could complete without suspending.

        [Theory]
        [InlineData("byte")]
        [InlineData("int")]
        [InlineData("long")]
        [InlineData("short")]
        [InlineData("float")]
        [InlineData("double")]
        public async Task ReadShouldThrowWhenTokenAlreadyCancelledEvenIfStreamCanCompleteSync(string kind)
        {
            using var cts = new CancellationTokenSource();
            cts.Cancel();
            // Plenty of bytes available and a stream that would complete synchronously.
            var data = new byte[] { 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08 };
            var stream = new SyncPartialStream(data, chunkSize: 8);

            // Invoke inside the lambda so a synchronous throw at the entry point (the token flows
            // straight into stream.ReadAsync, which may throw before returning a ValueTask) is
            // caught the same as an asynchronous one.
            await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            {
                switch (kind)
                {
                    case "byte": await stream.ReadByteAsync(cts.Token); break;
                    case "int": await stream.ReadIntAsync(cts.Token); break;
                    case "long": await stream.ReadLongAsync(cts.Token); break;
                    case "short": await stream.ReadShortAsync(cts.Token); break;
                    case "float": await stream.ReadFloatAsync(cts.Token); break;
                    case "double": await stream.ReadDoubleAsync(cts.Token); break;
                    default: throw new ArgumentOutOfRangeException(nameof(kind));
                }
            });
        }

        // --- Case 7: deterministic concurrent contention on the shared _scratch --------------

        [Fact]
        public async Task TwoReadsPendingOnSharedScratchShouldBothReturnCorrectValues()
        {
            // Provably force two reads to be in flight at the same time. Read #1 issues ReadAsync
            // on the shared _scratch and blocks on the gate (so the entry point detaches _scratch
            // and awaits). Only after #1 is confirmed pending do we start #2, which must lazily
            // allocate its own fresh buffer. Releasing the gate lets both complete; both must
            // reassemble their own distinct value with no cross-contamination.
            var gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

            var stream1 = new GatedStream(new byte[] { 0x01, 0x02, 0x03, 0x04 }, gate);
            var read1 = stream1.ReadIntAsync().AsTask();

            // Wait until read #1 has actually issued its ReadAsync and is parked on the gate.
            await stream1.FirstReadIssued;

            // Start read #2 on a stream that completes on its own; its first read must not reuse
            // the buffer detached by read #1.
            var stream2 = new DripStream(new byte[] { 0x11, 0x12, 0x13, 0x14 }, chunkSize: 1);
            var read2 = stream2.ReadIntAsync().AsTask();

            // Release read #1; now both are free to finish.
            gate.SetResult(true);

            var results = await Task.WhenAll(read1, read2);

            Assert.Equal(0x01020304, results[0]);
            Assert.Equal(0x11121314, results[1]);
        }

        [Fact]
        public async Task ManyGatedInterleavedReadsReleasedOutOfOrderShouldAllBeCorrect()
        {
            // Guards the detach under controlled interleaving: many reads are held pending on the
            // shared _scratch simultaneously (each parked on its own gate), then released in the
            // reverse of the order they were started. Every read must still reassemble its own
            // distinct value, proving no in-flight buffer is clobbered by a later reentrant read.
            const int count = 64;
            var gates = new TaskCompletionSource<bool>[count];
            var streams = new GatedStream[count];
            var reads = new Task<int>[count];

            for (var i = 0; i < count; i++)
            {
                gates[i] = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                var bytes = new byte[4];
                System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(bytes, i);
                streams[i] = new GatedStream(bytes, gates[i]);
                reads[i] = streams[i].ReadIntAsync().AsTask();
                // Ensure this read is parked on its gate before starting the next one.
                await streams[i].FirstReadIssued;
            }

            // Release in reverse order.
            for (var i = count - 1; i >= 0; i--)
            {
                gates[i].SetResult(true);
            }

            var results = await Task.WhenAll(reads);

            for (var i = 0; i < count; i++)
            {
                Assert.Equal(i, results[i]);
            }
        }

        // --- Case 8: chunk-size Theory on the async slow path --------------------------------
        // chunkSize {1,3,5} straddles the 4- and 8-byte widths: 3 and 5 exercise the async
        // remainder branch (n < width) at offsets other than 1, and 5 hits the no-remainder
        // (n == width) skip branch for the 4-byte int.

        [Theory]
        [InlineData(1)]
        [InlineData(3)]
        [InlineData(5)]
        public async Task ReadIntAsyncShouldReassembleAcrossVariedAsyncChunkSizes(int chunkSize)
        {
            var stream = new DripStream(new byte[] { 0x01, 0x02, 0x03, 0x04 }, chunkSize);

            var result = await stream.ReadIntAsync();

            Assert.Equal(0x01020304, result);
        }

        [Theory]
        [InlineData(1)]
        [InlineData(3)]
        [InlineData(5)]
        public async Task ReadLongAsyncShouldReassembleAcrossVariedAsyncChunkSizes(int chunkSize)
        {
            var stream = new DripStream(
                new byte[] { 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08 }, chunkSize);

            var result = await stream.ReadLongAsync();

            Assert.Equal(0x0102030405060708L, result);
        }

        // --- Case 9: negative / all-0xFF values on the slow path ----------------------------
        // Guards the AsSpan(0, N) slicing and BOTH reassembly parse sites (Await* parses
        // buf.AsSpan(0, N); Finish* parses the full private byte[N]) for sign-bit-set values.

        [Fact]
        public async Task ReadIntAsyncShouldReassembleNegativeValueOnAsyncSlowPath()
        {
            var stream = new DripStream(new byte[] { 0xFF, 0xFF, 0xFF, 0xFF }, chunkSize: 1);

            var result = await stream.ReadIntAsync();

            Assert.Equal(-1, result);
        }

        [Fact]
        public async Task ReadIntAsyncShouldReassembleNegativeValueOnSyncPartialPath()
        {
            var stream = new SyncPartialStream(new byte[] { 0xFF, 0xFF, 0xFF, 0xFF }, chunkSize: 1);

            var result = await stream.ReadIntAsync();

            Assert.Equal(-1, result);
        }

        [Fact]
        public async Task ReadLongAsyncShouldReassembleNegativeValueOnAsyncSlowPath()
        {
            var stream = new DripStream(
                new byte[] { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF }, chunkSize: 1);

            var result = await stream.ReadLongAsync();

            Assert.Equal(-1L, result);
        }

        [Fact]
        public async Task ReadLongAsyncShouldReassembleNegativeValueOnSyncPartialPath()
        {
            var stream = new SyncPartialStream(
                new byte[] { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF }, chunkSize: 3);

            var result = await stream.ReadLongAsync();

            Assert.Equal(-1L, result);
        }

        [Fact]
        public async Task ReadFloatAsyncShouldReassembleNegativeValueOnAsyncSlowPath()
        {
            // -2.0f == 0xC0000000 big-endian (sign bit set).
            var expected = -2.0f;
            var bytes = new byte[4];
            System.Buffers.Binary.BinaryPrimitives.WriteSingleBigEndian(bytes, expected);
            var stream = new DripStream(bytes, chunkSize: 1);

            var result = await stream.ReadFloatAsync();

            Assert.Equal(expected, result);
        }

        [Fact]
        public async Task ReadDoubleAsyncShouldReassembleNegativeValueOnSyncPartialPath()
        {
            var expected = -2.0d;
            var bytes = new byte[8];
            System.Buffers.Binary.BinaryPrimitives.WriteDoubleBigEndian(bytes, expected);
            var stream = new SyncPartialStream(bytes, chunkSize: 5);

            var result = await stream.ReadDoubleAsync();

            Assert.Equal(expected, result);
        }
    }
}
