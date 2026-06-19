import { z } from "zod";
import { getApiBase } from "../config.js";
import {
  dvReq,
  dvHeaders,
  asArray,
  throwIfPssCreateError,
} from "../dataverse.js";
import type { ToolDef } from "./types.js";

const ALLOWED = [
  "Microsoft.Dynamics.CRM.msdyn_projecttask",
  "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency",
  "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
  "Microsoft.Dynamics.CRM.msdyn_projectbucket",
  "Microsoft.Dynamics.CRM.msdyn_projectsprint",
  "Microsoft.Dynamics.CRM.msdyn_projectchecklist",
  "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel",
];

// Engine-managed fields the PSS API rejects on CREATE (ScheduleAPI-AV-0001).
// Set them via PSS Batch Update AFTER the create OperationSet completes.
const BLOCKED_ON_CREATE = [
  "msdyn_ismilestone",
  "msdyn_progress",
  "msdyn_actualstart",
  "msdyn_actualfinish",
];

// Outline level / display sequence are also blocked on create, but the remedy is different:
// hierarchy comes from msdyn_parenttask@odata.bind (parents before children in the same
// batch), NOT from these fields. Rejected with a pointer to parent binds.
const HIERARCHY_BLOCKED = ["msdyn_outlinelevel", "msdyn_displaysequence"];

// Wrong navigation-property names observed (or likely) in agent-generated payloads. These are
// NOT valid @odata.bind navigation properties; the value is fine, only the key is wrong. We
// THROW (never auto-correct) so the calling agent learns the right key for the rest of the session.
// These are scoped PER ENTITY TYPE: the SAME key can be correct on one entity and
// wrong on another. e.g. `msdyn_projectid@odata.bind` is WRONG on a task (use
// `msdyn_project`) but CORRECT on msdyn_resourceassignment / msdyn_projectlabel.
// So the task aliases only apply to task entities and the dependency aliases only
// to dependency entities — other entity types (assignments, checklists, labels,
// sprints, buckets) are left to PSS to validate.
const TASK_BIND_ALIASES: Record<string, string> = {
  "msdyn_bucket@odata.bind": "msdyn_projectbucket@odata.bind",
  "msdyn_projectbucketid@odata.bind": "msdyn_projectbucket@odata.bind",
  "msdyn_projectid@odata.bind": "msdyn_project@odata.bind",
  "msdyn_parent@odata.bind": "msdyn_parenttask@odata.bind",
  "msdyn_parenttaskid@odata.bind": "msdyn_parenttask@odata.bind",
};
// Dependency lookups bind on the PascalCase schema names. The lowercase logical
// names make Dataverse reject the payload as an annotation-only property with no
// value; teach the correct key instead.
const DEP_BIND_ALIASES: Record<string, string> = {
  "msdyn_predecessortask@odata.bind": "msdyn_PredecessorTask@odata.bind",
  "msdyn_successortask@odata.bind": "msdyn_SuccessorTask@odata.bind",
};

// Dependency link types - option-set values of msdyn_projecttaskdependencylinktype.
// FS is the default when the field is omitted.
// Two value ranges exist: 192350000-style (global tenants) and 0-3 (EU/CRM4 tenants).
// Both are accepted here so raw callers on either tenant can send valid payloads.
const LINK_TYPES: Record<number, string> = {
  192350000: "FS", // Finish-to-Start (default)
  192350001: "SS", // Start-to-Start
  192350002: "FF", // Finish-to-Finish
  192350003: "SF", // Start-to-Finish
  // EU/CRM4 small-integer range (confirmed via describe_option_set on CRM4 env)
  0: "FF",
  1: "FS",
  2: "SF",
  3: "SS",
};

/**
 * Validates the entity batch for msdyn_PssCreateV2. Throws on the first
 * problem, with the same message text the original action used. Pure: no
 * network, so it is unit-testable on its own.
 */
export function validateAddEntities(entities: any[]): void {
  if (!Array.isArray(entities) || entities.length === 0)
    throw new Error("entities must be a non-empty JSON array.");
  if (entities.length > 200)
    throw new Error(
      "Too many entities (" +
        entities.length +
        "). Max 200 per OperationSet - split into batches.",
    );

  // Pre-pass: index task primary keys so msdyn_parenttask@odata.bind references to tasks created
  // in this same batch can be checked for ordering (parents must come before children).
  const taskIndexById: Record<string, number> = {};
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (
      e["@odata.type"] === "Microsoft.Dynamics.CRM.msdyn_projecttask" &&
      typeof e.msdyn_projecttaskid === "string"
    ) {
      taskIndexById[e.msdyn_projecttaskid.toLowerCase()] = i;
    }
  }

  const seenIds: Record<string, { idx: number }> = {};
  for (let i = 0; i < entities.length; i++) {
    const ent = entities[i];
    const t = ent["@odata.type"];
    if (!t || !ALLOWED.includes(t)) {
      throw new Error(
        "entities[" +
          i +
          "]: missing or disallowed @odata.type '" +
          t +
          "'. Allowed: " +
          ALLOWED.join(", "),
      );
    }
    // Reject known wrong @odata.bind navigation-property names (teaches the correct
    // key). Scoped per entity type so a bind that is valid on one entity is not
    // falsely rejected on another.
    const aliasMap =
      t === "Microsoft.Dynamics.CRM.msdyn_projecttask"
        ? TASK_BIND_ALIASES
        : t === "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency"
          ? DEP_BIND_ALIASES
          : null;
    if (aliasMap) {
      for (const wrong in aliasMap) {
        if (Object.prototype.hasOwnProperty.call(ent, wrong)) {
          throw new Error(
            "entities[" +
              i +
              "]: '" +
              wrong +
              "' is not a valid navigation property. Use '" +
              aliasMap[wrong] +
              "' instead (value unchanged).",
          );
        }
      }
    }
    const bad = Object.keys(ent).filter((k) =>
      BLOCKED_ON_CREATE.includes(k.toLowerCase()),
    );
    if (bad.length) {
      throw new Error(
        "entities[" +
          i +
          "]: field(s) not allowed on PSS create: " +
          bad.join(", ") +
          ". Remove them and set them via 'Update Tasks in Plan (Batch)' after this change session completes.",
      );
    }
    const badHier = Object.keys(ent).filter((k) =>
      HIERARCHY_BLOCKED.includes(k.toLowerCase()),
    );
    if (badHier.length) {
      throw new Error(
        "entities[" +
          i +
          "]: field(s) " +
          badHier.join(", ") +
          " are blocked on create. Outline structure comes from msdyn_parenttask@odata.bind (parents before children in the same batch), NOT from msdyn_outlinelevel / msdyn_displaysequence.",
      );
    }
    const idKeys = Object.keys(ent).filter(
      (k) =>
        /id$/i.test(k) &&
        typeof ent[k] === "string" &&
        /^[0-9a-fA-F-]{36}$/.test(ent[k]),
    );
    for (const k of idKeys) {
      const key = k + ":" + ent[k].toLowerCase();
      if (seenIds[key])
        throw new Error(
          "entities[" +
            i +
            "]: duplicate GUID " +
            ent[k] +
            " (" +
            k +
            ") already used in entities[" +
            seenIds[key].idx +
            "]. Each entity needs a unique client-generated GUID.",
        );
      seenIds[key] = { idx: i };
    }
    if (t === "Microsoft.Dynamics.CRM.msdyn_projecttask") {
      const missing: string[] = [];
      if (!ent.msdyn_subject) missing.push("msdyn_subject");
      if (!ent["msdyn_project@odata.bind"]) missing.push("msdyn_project@odata.bind");
      if (!ent["msdyn_projectbucket@odata.bind"])
        missing.push("msdyn_projectbucket@odata.bind");
      if (missing.length) {
        throw new Error(
          "entities[" + i + "] (task): missing required field(s): " + missing.join(", ") + ".",
        );
      }
      // Hierarchy: validate the parent bind shape and parents-before-children ordering.
      const pBind = ent["msdyn_parenttask@odata.bind"];
      if (pBind !== undefined && pBind !== null) {
        const m = String(pBind).match(/^\/msdyn_projecttasks\(([0-9a-fA-F-]{36})\)$/);
        if (!m) {
          throw new Error(
            "entities[" +
              i +
              "] (task): msdyn_parenttask@odata.bind must be of the form /msdyn_projecttasks(<guid>).",
          );
        }
        const parentGuid = m[1].toLowerCase();
        if (
          Object.prototype.hasOwnProperty.call(taskIndexById, parentGuid) &&
          taskIndexById[parentGuid] >= i
        ) {
          throw new Error(
            "entities[" +
              i +
              "] (task): parent task " +
              m[1] +
              " is created at or after this entity (entities[" +
              taskIndexById[parentGuid] +
              "]). Parents must appear BEFORE their children in the same batch.",
          );
        }
      }
    }
    if (t === "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency") {
      // On dependency entities ALL lookup nav-properties use PascalCase schema names.
      // Teach the correct casing for the project bind (different from task entities
      // where msdyn_project@odata.bind, lowercase, is correct).
      if (Object.prototype.hasOwnProperty.call(ent, "msdyn_project@odata.bind")) {
        throw new Error(
          "entities[" +
            i +
            "] (dependency): 'msdyn_project@odata.bind' is not a valid navigation property on msdyn_projecttaskdependency." +
            " Use 'msdyn_Project@odata.bind' (capital P) — all lookup binds on dependency entities use PascalCase schema names.",
        );
      }
      if (
        !ent["msdyn_PredecessorTask@odata.bind"] ||
        !ent["msdyn_SuccessorTask@odata.bind"]
      ) {
        throw new Error(
          "entities[" +
            i +
            "] (dependency): msdyn_PredecessorTask@odata.bind and msdyn_SuccessorTask@odata.bind are required (PascalCase nav-property names).",
        );
      }
      // Optional link type: if present it must be one of the FS/SS/FF/SF option values.
      const lt = ent.msdyn_projecttaskdependencylinktype;
      if (lt !== undefined && lt !== null) {
        if (!Object.prototype.hasOwnProperty.call(LINK_TYPES, lt)) {
          throw new Error(
            "entities[" +
              i +
              "] (dependency): msdyn_projecttaskdependencylinktype '" +
              lt +
              "' is invalid. Allowed option values: " +
              Object.keys(LINK_TYPES)
                .map((k) => k + "=" + LINK_TYPES[Number(k)])
                .join(", ") +
              " (FS=Finish-to-Start is the default when omitted).",
          );
        }
      }
      // Optional lag: msdyn_projecttaskdependencylinklag in minutes. Passed through unchanged.
      const lag = ent.msdyn_projecttaskdependencylinklag;
      if (lag !== undefined && lag !== null && typeof lag !== "number") {
        throw new Error(
          "entities[" +
            i +
            "] (dependency): msdyn_projecttaskdependencylinklag must be a number (lag in minutes).",
        );
      }
    }
  }
}

// PSS Batch Create - msdyn_PssCreateV2 (tasks, dependencies, assignments in ONE call)
export const addTasks: ToolDef = {
  name: "add_tasks_batch",
  title: "Add Tasks to Plan (Batch)",
  description:
    "ADVANCED / raw path. For ordinary tasks, hierarchy and dependencies prefer add_tasks (you pass a plain list and the server builds this payload). Use this raw tool only when you need entity types add_tasks does not model (resource assignments, checklists, sprints, labels) or custom fields. " +
    "Adds up to 200 items (tasks, dependencies, assignments, checklists) to a plan in ONE msdyn_PssCreateV2 call; requires an open change session (operationSetId). Tasks need msdyn_subject + project & bucket @odata.bind; use client-generated GUIDs so same-batch references work; order = display order. Hierarchy comes from msdyn_parenttask@odata.bind (parents BEFORE children in the same batch), NOT msdyn_outlinelevel (blocked on create). Dependencies default to FS; msdyn_projecttaskdependencylinktype supports FS/SS/FF/SF option values; lag via msdyn_projecttaskdependencylinklag (minutes); invalid dependency fields are rejected, never silently dropped. msdyn_ismilestone, msdyn_progress and actuals are rejected on create - set them afterwards via 'Update Tasks in Plan (Batch)'. Submit each batch exactly once; nothing is saved until 'Apply Changes to Plan'.",
  inputSchema: {
    operationSetId: z
      .string()
      .describe("GUID of the open OperationSet (from 'Start Change Session')."),
    entities: z
      .union([z.string(), z.array(z.record(z.any()))])
      .describe(
        "JSON array of entities to create. Each item needs '@odata.type' (e.g. Microsoft.Dynamics.CRM.msdyn_projecttask), a client-generated GUID primary key, and @odata.bind lookups. Tasks require: msdyn_subject, msdyn_project@odata.bind = /msdyn_projects(<guid>), msdyn_projectbucket@odata.bind = /msdyn_projectbuckets(<guid>). Hierarchy: msdyn_parenttask@odata.bind = /msdyn_projecttasks(<guid>), parents before children. Order = display order. Max 200.",
      ),
  },
  handler: async (input: { operationSetId: string; entities: unknown }) => {
    const BASE = getApiBase();

    const operationSetId = (input.operationSetId || "").trim();
    if (!operationSetId) throw new Error("operationSetId is required.");

    const entities = asArray(input.entities, "entities");
    validateAddEntities(entities);

    const response = await dvReq({
      url: BASE + "/msdyn_PssCreateV2",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { EntityCollection: entities, OperationSetId: operationSetId },
    });

    throwIfPssCreateError(response);
    return {
      ok: true,
      queued: entities.length,
      response: response.json || {},
      note: "Queued in change session. Order = display order. NOT saved until 'Apply Changes to Plan'.",
    };
  },
};
