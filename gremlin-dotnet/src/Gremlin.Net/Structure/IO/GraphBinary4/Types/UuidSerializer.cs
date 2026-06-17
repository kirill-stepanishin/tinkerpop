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
using System.Threading;
using System.Threading.Tasks;

namespace Gremlin.Net.Structure.IO.GraphBinary4.Types
{
    /// <summary>
    /// A serializer that serializes <see cref="Guid"/> values as Uuid in GraphBinary.
    /// </summary>
    public class UuidSerializer : SimpleTypeSerializer<Guid>
    {
        /// <summary>
        ///     Initializes a new instance of the <see cref="UuidSerializer" /> class.
        /// </summary>
        public UuidSerializer() : base(DataType.Uuid)
        {
        }

        /// <inheritdoc />
        protected override async Task WriteValueAsync(Guid value, Stream stream, GraphBinaryWriter writer,
            CancellationToken cancellationToken = default)
        {
            var bytes = value.ToByteArray();
            
            // first 4 bytes in reverse order:
            await stream.WriteByteAsync(bytes[3], cancellationToken).ConfigureAwait(false);
            await stream.WriteByteAsync(bytes[2], cancellationToken).ConfigureAwait(false);
            await stream.WriteByteAsync(bytes[1], cancellationToken).ConfigureAwait(false);
            await stream.WriteByteAsync(bytes[0], cancellationToken).ConfigureAwait(false);
            
            // 2 bytes in reverse order:
            await stream.WriteByteAsync(bytes[5], cancellationToken).ConfigureAwait(false);
            await stream.WriteByteAsync(bytes[4], cancellationToken).ConfigureAwait(false);
            
            // 3 bytes in reverse order:
            await stream.WriteByteAsync(bytes[7], cancellationToken).ConfigureAwait(false);
            await stream.WriteByteAsync(bytes[6], cancellationToken).ConfigureAwait(false);
            
            // 3 bytes:
            await stream.WriteByteAsync(bytes[8], cancellationToken).ConfigureAwait(false);
            await stream.WriteByteAsync(bytes[9], cancellationToken).ConfigureAwait(false);
            
            // last 6 bytes:
            await stream.WriteByteAsync(bytes[10], cancellationToken).ConfigureAwait(false);
            await stream.WriteByteAsync(bytes[11], cancellationToken).ConfigureAwait(false);
            await stream.WriteByteAsync(bytes[12], cancellationToken).ConfigureAwait(false);
            await stream.WriteByteAsync(bytes[13], cancellationToken).ConfigureAwait(false);
            await stream.WriteByteAsync(bytes[14], cancellationToken).ConfigureAwait(false);
            await stream.WriteByteAsync(bytes[15], cancellationToken).ConfigureAwait(false);
        }

        /// <inheritdoc />
        protected override async Task<Guid> ReadValueAsync(Stream stream, GraphBinaryReader reader,
            CancellationToken cancellationToken = default)
        {
            // Read all 16 bytes in a single buffered async read (one array, one ReadExactlyAsync)
            // instead of 16 sequential awaited ReadByteAsync calls (each allocating a byte[1]).
            var raw = await stream.ReadAsync(16, cancellationToken).ConfigureAwait(false);

            // The byte permutation uses a stackalloc Span<byte>; that lives entirely in the
            // synchronous helper below, since a Span<byte> cannot cross an await (and a ref/span
            // local is not even permitted in an async method body under C# 12).
            return ToGuid(raw);
        }

        private static Guid ToGuid(byte[] raw)
        {
            // Apply the same explicit byte permutation as the writer, synchronously, into a
            // stack-allocated span.
            Span<byte> guidBytes = stackalloc byte[16];

            // first 4 bytes in reverse order:
            guidBytes[3] = raw[0];
            guidBytes[2] = raw[1];
            guidBytes[1] = raw[2];
            guidBytes[0] = raw[3];

            // 2 bytes in reverse order:
            guidBytes[5] = raw[4];
            guidBytes[4] = raw[5];

            // 2 bytes in reverse order:
            guidBytes[7] = raw[6];
            guidBytes[6] = raw[7];

            // 2 bytes:
            guidBytes[8] = raw[8];
            guidBytes[9] = raw[9];

            // last 6 bytes:
            raw.AsSpan(10, 6).CopyTo(guidBytes[10..]);

            return new Guid(guidBytes);
        }
    }
}