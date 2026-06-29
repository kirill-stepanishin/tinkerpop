/*
 *  Licensed to the Apache Software Foundation (ASF) under one
 *  or more contributor license agreements.  See the NOTICE file
 *  distributed with this work for additional information
 *  regarding copyright ownership.  The ASF licenses this file
 *  to you under the Apache License, Version 2.0 (the
 *  "License"); you may not use this file except in compliance
 *  with the License.  You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing,
 *  software distributed under the License is distributed on an
 *  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 *  KIND, either express or implied.  See the License for the
 *  specific language governing permissions and limitations
 *  under the License.
 */

import { assert } from 'chai';
import { Buffer } from 'buffer';
import SyncBufferReader from '../../../lib/structure/io/binary/internals/SyncBufferReader.js';

describe('SyncBufferReader', () => {
  describe('fromBuffer', () => {
    it('readUInt8 reads single bytes', () => {
      const reader = SyncBufferReader.fromBuffer(Buffer.from([0x01, 0xff, 0x00]));
      assert.equal(reader.readUInt8(), 0x01);
      assert.equal(reader.readUInt8(), 0xff);
      assert.equal(reader.readUInt8(), 0x00);
    });

    it('readByte reads signed bytes', () => {
      const reader = SyncBufferReader.fromBuffer(Buffer.from([0x7f, 0x80]));
      assert.equal(reader.readByte(), 127);
      assert.equal(reader.readByte(), -128);
    });

    it('readInt16BE reads signed 16-bit', () => {
      const buf = Buffer.alloc(4);
      buf.writeInt16BE(12345, 0);
      buf.writeInt16BE(-1, 2);
      const reader = SyncBufferReader.fromBuffer(buf);
      assert.equal(reader.readInt16BE(), 12345);
      assert.equal(reader.readInt16BE(), -1);
    });

    it('readInt32BE reads signed 32-bit', () => {
      const buf = Buffer.alloc(8);
      buf.writeInt32BE(2147483647, 0);
      buf.writeInt32BE(-2147483648, 4);
      const reader = SyncBufferReader.fromBuffer(buf);
      assert.equal(reader.readInt32BE(), 2147483647);
      assert.equal(reader.readInt32BE(), -2147483648);
    });

    it('readBigInt64BE reads signed 64-bit', () => {
      const buf = Buffer.alloc(8);
      buf.writeBigInt64BE(9223372036854775807n, 0);
      const reader = SyncBufferReader.fromBuffer(buf);
      assert.equal(reader.readBigInt64BE(), 9223372036854775807n);
    });

    it('readFloatBE reads 32-bit float', () => {
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(3.14, 0);
      const reader = SyncBufferReader.fromBuffer(buf);
      assert.closeTo(reader.readFloatBE(), 3.14, 0.001);
    });

    it('readDoubleBE reads 64-bit double', () => {
      const buf = Buffer.alloc(8);
      buf.writeDoubleBE(3.141592653589793, 0);
      const reader = SyncBufferReader.fromBuffer(buf);
      assert.equal(reader.readDoubleBE(), 3.141592653589793);
    });

    it('readBytes returns exact slice', () => {
      const reader = SyncBufferReader.fromBuffer(Buffer.from([0x01, 0x02, 0x03, 0x04]));
      const bytes = reader.readBytes(2);
      assert.deepEqual([...bytes], [0x01, 0x02]);
      const rest = reader.readBytes(2);
      assert.deepEqual([...rest], [0x03, 0x04]);
    });

    it('throws on read past end of buffer', () => {
      const reader = SyncBufferReader.fromBuffer(Buffer.from([0x01]));
      reader.readUInt8();
      try {
        reader.readUInt8();
        assert.fail('should have thrown');
      } catch (e) {
        assert.match(e.message, /Unexpected end of buffer/);
      }
    });

    it('mixed reads advance offset correctly', () => {
      const buf = Buffer.alloc(13);
      buf.writeUInt8(0xAB, 0);
      buf.writeInt32BE(42, 1);
      buf.writeDoubleBE(1.5, 5);
      const reader = SyncBufferReader.fromBuffer(buf);
      assert.equal(reader.readUInt8(), 0xAB);
      assert.equal(reader.readInt32BE(), 42);
      assert.equal(reader.readDoubleBE(), 1.5);
    });

    it('position reflects bytes consumed', () => {
      const reader = SyncBufferReader.fromBuffer(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]));
      assert.equal(reader.position, 0);
      reader.readUInt8();
      assert.equal(reader.position, 1);
      reader.readInt32BE();
      assert.equal(reader.position, 5);
    });

    it('reads are awaitable like the async reader', async () => {
      // Serializers do `await reader.readX()`; awaiting a non-thenable must work.
      const reader = SyncBufferReader.fromBuffer(Buffer.from([0x84, 0x01]));
      assert.equal(await reader.readUInt8(), 0x84);
      assert.equal(await reader.readUInt8(), 0x01);
    });
  });
});
