/*
 *  Licensed to the Apache Software Foundation (ASF) under one
 *  or more contributor license agreements.  See the NOTICE file
 *  distributed with this work for additional information
 *  regarding copyright ownership.  The ASF licenses this file
 *  to you under the Apache License, Version 2.0 (the
 *  "License"); you may not use this file except in compliance
 *  with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing,
 *  software distributed under the License is distributed on an
 *  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 *  KIND, either express or implied.  See the License for the
 *  specific language governing permissions and limitations
 *  under the License.
 */

/**
 * Synchronous byte reader over a fully-buffered Buffer, used by the non-streaming
 * submit()/readResponse path. It exposes the exact same method names as StreamReader
 * (readUInt8, readByte, readInt16BE, readInt32BE, readBigInt64BE, readFloatBE,
 * readDoubleBE, readBytes, a `position` getter, and a writable `pdtRegistry` field),
 * but none are async: each read is a direct Buffer-offset read that bumps the offset
 * and position and throws synchronously on overflow.
 *
 * Because the serializers already `await reader.readX()` and awaiting a non-thenable
 * value is legal, the identical serializer code runs unchanged against this reader —
 * it simply stops allocating a Promise per primitive read.
 */
export default class SyncBufferReader {
  /** @type {Buffer} */
  #buffer;
  /** @type {number} */
  #offset;
  /** @type {number} Total bytes consumed (monotonically increasing) */
  #position;

  /**
   * @param {Buffer} buffer
   */
  constructor(buffer) {
    this.#buffer = buffer;
    this.#offset = 0;
    this.#position = 0;
  }

  /**
   * Create a SyncBufferReader backed by a complete Buffer.
   * @param {Buffer} buffer
   * @returns {SyncBufferReader}
   */
  static fromBuffer(buffer) {
    return new SyncBufferReader(buffer);
  }

  /**
   * Bounds check: ensure at least `n` bytes remain from the current offset.
   * Throws with the exact same message StreamReader uses for buffer-backed overflow.
   * @param {number} n
   */
  #ensure(n) {
    const available = this.#buffer.length - this.#offset;
    if (available < n) {
      throw new Error(
        `Unexpected end of buffer at position ${this.#position}: needed ${n} bytes, ${available} available`,
      );
    }
  }

  /**
   * Total number of bytes consumed so far (monotonically increasing).
   * @returns {number}
   */
  get position() {
    return this.#position;
  }

  /**
   * Read exactly `n` bytes and return them as a Buffer.
   * @param {number} n
   * @returns {Buffer}
   */
  readBytes(n) {
    this.#ensure(n);
    const result = this.#buffer.subarray(this.#offset, this.#offset + n);
    this.#offset += n;
    this.#position += n;
    return result;
  }

  /**
   * @returns {number} unsigned 8-bit integer
   */
  readUInt8() {
    this.#ensure(1);
    this.#position++;
    return this.#buffer[this.#offset++];
  }

  /**
   * @returns {number} signed 8-bit integer
   */
  readByte() {
    this.#ensure(1);
    this.#position++;
    return this.#buffer.readInt8(this.#offset++);
  }

  /**
   * @returns {number} signed 16-bit big-endian integer
   */
  readInt16BE() {
    this.#ensure(2);
    const v = this.#buffer.readInt16BE(this.#offset);
    this.#offset += 2;
    this.#position += 2;
    return v;
  }

  /**
   * @returns {number} signed 32-bit big-endian integer
   */
  readInt32BE() {
    this.#ensure(4);
    const v = this.#buffer.readInt32BE(this.#offset);
    this.#offset += 4;
    this.#position += 4;
    return v;
  }

  /**
   * @returns {bigint} signed 64-bit big-endian integer
   */
  readBigInt64BE() {
    this.#ensure(8);
    const v = this.#buffer.readBigInt64BE(this.#offset);
    this.#offset += 8;
    this.#position += 8;
    return v;
  }

  /**
   * @returns {number} 32-bit big-endian float
   */
  readFloatBE() {
    this.#ensure(4);
    const v = this.#buffer.readFloatBE(this.#offset);
    this.#offset += 4;
    this.#position += 4;
    return v;
  }

  /**
   * @returns {number} 64-bit big-endian double
   */
  readDoubleBE() {
    this.#ensure(8);
    const v = this.#buffer.readDoubleBE(this.#offset);
    this.#offset += 8;
    this.#position += 8;
    return v;
  }
}
