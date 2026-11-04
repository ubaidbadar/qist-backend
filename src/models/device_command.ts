import { model, Schema } from 'mongoose';
import { COMMAND_SOURCES, COMMAND_STATUSES, COMMAND_TYPES } from '@shop/shared';
import { tenantGuard } from '../db/tenant_guard';

export const OPEN_STATUSES = ['proposed', 'pending'] as const;

/**
 * An instruction for a phone: lock, unlock, or release once paid off. Proposed locks wait for a manager; pending
 * commands wait for the device app (Phase 2), which reports delivered and acknowledged.
 */
const deviceCommandSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    branchId: { type: Schema.Types.ObjectId, required: true },
    deviceId: { type: Schema.Types.ObjectId, required: true },
    contractId: { type: Schema.Types.ObjectId, required: true },
    customerName: { type: String, required: true },
    deviceLabel: { type: String, required: true },
    type: { type: String, enum: COMMAND_TYPES, required: true },
    status: { type: String, enum: COMMAND_STATUSES, required: true },
    source: { type: String, enum: COMMAND_SOURCES, required: true },
    reason: { type: String, required: true },
    requestedBy: { type: Schema.Types.ObjectId, default: null }, // null: the system
    requestedByName: { type: String, required: true },
    decidedBy: { type: Schema.Types.ObjectId, default: null },
    decidedByName: { type: String, default: '' },
    decisionReason: { type: String, default: '' },
  },
  { collection: 'deviceCommands', timestamps: true, versionKey: false },
);

deviceCommandSchema.index({ orgId: 1, contractId: 1, _id: -1 }); // a contract's lock history
deviceCommandSchema.index({ orgId: 1, status: 1, _id: -1 }); // Lock Center queues
deviceCommandSchema.index({ orgId: 1, deviceId: 1, status: 1, _id: 1 }); // phone check-ins, including delivered commands
// One open command per phone at a time, guaranteed by the database.
deviceCommandSchema.index({ orgId: 1, deviceId: 1 }, { unique: true, partialFilterExpression: { status: { $in: [...OPEN_STATUSES] } } });

deviceCommandSchema.plugin(tenantGuard);

export const DeviceCommand = model('DeviceCommand', deviceCommandSchema);
