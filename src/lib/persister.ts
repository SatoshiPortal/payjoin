import { PrismaClient } from "@prisma/client";
import logger from "./Log2File";

export class ReceiverPersister {
  private id: number | string | undefined;
  private db: PrismaClient | undefined;
  private events: any[];
  private closed: boolean;
  private onSave?: (event: any[]) => void;
  private pendingSaves: Promise<unknown>[] = [];

  constructor({id, db, onSave}: {id?: number | string, db?: PrismaClient, onSave?: (event: any[]) => void}) {
    this.id = id;
    this.db = db;
    this.events = [];
    this.closed = false;
    this.onSave = onSave;
  }

  restore(events: any[]) {
    this.events = events;
  }

  save(event: string) {
    logger.debug(ReceiverPersister.name, 'Saving event to persister:', event);
    this.events.push(event);
    if (this.id && this.db) {
      logger.debug(ReceiverPersister.name, 'Saving event to database for id:', this.id);
      const p = this.db.receive.update({
        where: { id: Number(this.id) },
        data: {
            session: JSON.stringify(this.events),
        }
      }).then(() => {
        logger.debug(ReceiverPersister.name, 'Event saved to database successfully');
      }).catch((err) => {
        logger.error(ReceiverPersister.name, 'Error saving event to database:', err);
      });
      this.pendingSaves.push(p);
    }
    if (this.onSave) {
      logger.debug(ReceiverPersister.name, 'Calling onSave callback');
      this.onSave(this.events);
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.pendingSaves);
    this.pendingSaves = [];
  }

  load() {
    return this.events;
  }

  close() {
    this.closed = true;
  }
}

export class SenderPersister {
  private id: number | string | undefined;
  private db: PrismaClient | undefined;
  private events: any[];
  private closed: boolean;
  private onSave?: (event: any[]) => void;
  private pendingSaves: Promise<unknown>[] = [];

  constructor({id, db, onSave}: {id?: number | string, db?: PrismaClient, onSave?: (event: any[]) => void}) {
    this.id = id;
    this.db = db;
    this.events = [];
    this.closed = false;
    this.onSave = onSave;
  }

  restore(events: any[]) {
    this.events = events;
  }

  save(event: string) {
    logger.debug(SenderPersister.name, 'Saving event to persister:', event);
    this.events.push(event);
    if (this.id && this.db) {
      logger.debug(SenderPersister.name, 'Saving event to database for id:', this.id);
      const p = this.db.send.update({
        where: { id: Number(this.id) },
        data: {
          session: JSON.stringify(this.events),
        }
      }).then(() => {
        logger.debug(SenderPersister.name, 'Event saved to database successfully');
      }).catch((err) => {
        logger.error(SenderPersister.name, 'Error saving event to database:', err);
      });
      this.pendingSaves.push(p);
    }
    if (this.onSave) {
      logger.debug(SenderPersister.name, 'Calling onSave callback');
      this.onSave(this.events);
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.pendingSaves);
    this.pendingSaves = [];
  }

  load() {
    return this.events;
  }

  close() {
    this.closed = true;
  }
}
