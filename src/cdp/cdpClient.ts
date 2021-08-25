/**
 * Copyright 2021 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { EventEmitter } from 'events';
import { Connection } from './connection';

import * as browserProtocol from 'devtools-protocol/json/browser_protocol.json';
import * as jsProtocol from 'devtools-protocol/json/js_protocol.json';
import ProtocolProxyApi from 'devtools-protocol/types/protocol-proxy-api';
import ProtocolMapping from 'devtools-protocol/types/protocol-mapping';

// Publicly visible type. Has all of the methods of CdpClientImpl, and a property
// getter for each CDP Domain (provided by ProtocolApiExt).
export type CdpClient = CdpClientImpl & ProtocolApiExt;

// A type with the same set of properties as ProtocolProxyApi, but each domain
// property also extends DomainImpl.
type ProtocolApiExt = {
  [Domain in keyof ProtocolProxyApi.ProtocolApi]: DomainImpl &
    ProtocolProxyApi.ProtocolApi[Domain];
};

const mergedProtocol = [...browserProtocol.domains, ...jsProtocol.domains];

// Generate classes for each Domain and store constructors here.
const domainConstructorMap = new Map<
  string,
  { new (client: CdpClientImpl): DomainImpl }
>();

// Base class for all domains.
class DomainImpl extends EventEmitter {
  constructor(private _client: CdpClientImpl) {
    super();
  }
}

for (let domainInfo of mergedProtocol) {
  // Dynamically create a subclass for this domain. Note: This class definition is scoped
  // to this for-loop, so there will be a unique ThisDomain definition for each domain.
  class ThisDomain extends DomainImpl {
    constructor(_client: CdpClientImpl) {
      super(_client);
    }
  }

  // Add methods to our Domain for each available command.
  for (let command of domainInfo.commands) {
    Object.defineProperty(ThisDomain.prototype, command.name, {
      value: async function (params: {}) {
        return await this._client.sendCommand(
          `${domainInfo.domain}.${command.name}`,
          params
        );
      },
    });
  }

  domainConstructorMap.set(domainInfo.domain, ThisDomain);
}

class CdpClientImpl extends EventEmitter {
  private _domains: Map<string, DomainImpl>;

  constructor(
    private _connection: Connection,
    private _sessionId: string | null
  ) {
    super();

    this._domains = new Map();
    for (const [domainName, ctor] of domainConstructorMap.entries()) {
      this._domains.set(domainName, new ctor(this));
      Object.defineProperty(this, domainName, {
        get(this: CdpClientImpl) {
          return this._domains.get(domainName);
        },
      });
    }
  }

  /**
   * Returns command promise, which will be resolved wth the command result after receiving CDP result.
   * @param method Name of the CDP command to call.
   * @param params Parameters to pass to the CDP command.
   */
  sendCommand(method: string, params: {}): Promise<{}> {
    return this._connection._sendCommand(method, params, this._sessionId);
  }

  _onCdpEvent(method: string, params: {}) {
    // Emit a generic "event" event from here that includes the method name. Useful as a catch-all.
    this.emit('event', method, params);

    // Next, get the correct domain instance and tell it to emit the strongly typed event.
    const [domainName, eventName] = method.split('.');
    this._domains.get(domainName).emit(eventName, params);
  }

  public on<K extends keyof ProtocolMapping.Events>(
    event: 'event',
    listener: (message: { method: K; params: {} }) => void
  ): this;
  public on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

/**
 * Creates a new CDP client object that communicates with the browser using a given
 * transport mechanism.
 * @param transport A transport object that will be used to send and receive raw CDP messages.
 * @returns A connected CDP client object.
 */
export function createClient(connection: Connection, sessionId: string | null) {
  return new CdpClientImpl(connection, sessionId) as unknown as CdpClient;
}
