/**
 * Business Intake · adapter registry.
 *
 * The core looks a receipt's `sourceKey` up here and never branches on a
 * provider itself. A registry is an explicit object (not a global switch):
 * Production builds one with its real adapters (lib/intake/sources.ts); tests
 * build their own with reference adapters that are never reachable from a
 * Production route.
 */

import { isValidSourceKey, type IntakeAdapter } from "./contract";

export class IntakeRegistry {
  private readonly adapters = new Map<string, IntakeAdapter>();

  register(adapter: IntakeAdapter): this {
    if (!isValidSourceKey(adapter.sourceKey)) {
      throw new Error(`intake registry: invalid sourceKey`);
    }
    if (this.adapters.has(adapter.sourceKey)) {
      throw new Error(`intake registry: duplicate sourceKey ${adapter.sourceKey}`);
    }
    if (!/^[a-z][a-z0-9_.]*@[0-9]+$/.test(adapter.normalizerVersion)) {
      throw new Error(`intake registry: invalid normalizerVersion for ${adapter.sourceKey}`);
    }
    if (adapter.families.length === 0) {
      throw new Error(`intake registry: ${adapter.sourceKey} declares no families`);
    }
    this.adapters.set(adapter.sourceKey, adapter);
    return this;
  }

  get(sourceKey: string): IntakeAdapter | null {
    return this.adapters.get(sourceKey) ?? null;
  }

  list(): IntakeAdapter[] {
    return [...this.adapters.values()];
  }
}
