import { EventEmitter } from "node:events";

export type IndexUpdateKind =
  | "applications"
  | "reports"
  | "scan_history"
  | "pipeline"
  | "rejections";

export type IndexUpdateOp = "upsert" | "delete";

export type IndexUpdateEvent = {
  kind: IndexUpdateKind;
  op: IndexUpdateOp;
  path: string;
  id?: string | number;
};

class IndexBus extends EventEmitter {
  emitUpdate(ev: IndexUpdateEvent): void {
    this.emit("index:updated", ev);
    this.emit(`index:${ev.kind}:updated`, ev);
  }
}

export const indexBus = new IndexBus();
indexBus.setMaxListeners(50);
