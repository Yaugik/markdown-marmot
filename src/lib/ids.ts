import { randomUUID } from "node:crypto";

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
