import { describe, it, expect } from "vitest";
import {
  toWrite,
  fromRead,
  classifyAttribute,
  type ColumnMeta,
  type RawAttributeMetadata,
} from "../src/dataverse/columnTypes.js";

/**
 * Hand-written ColumnMeta fixtures per the PROVEN spec shapes
 * (scout-spec.md). One toWrite + fromRead assertion per §3.2 row, plus
 * boundary-reject cases. Money/MultiSelectPicklist/Customer/Image/File have
 * no live example on the probed tenant — fixtures here are hand-written per
 * the documented Dataverse shapes.
 */

function baseCol(overrides: Partial<ColumnMeta>): ColumnMeta {
  return {
    logicalName: "new_x",
    schemaName: "new_x",
    type: "string",
    isCustom: true,
    isValidForCreate: true,
    isValidForUpdate: true,
    isComputed: false,
    ...overrides,
  };
}

describe("string", () => {
  const col = baseCol({ logicalName: "new_subject", type: "string" });
  it("toWrite passes the string through", () => {
    expect(toWrite(col, "Hello world", "create")).toEqual([["new_subject", "Hello world"]]);
  });
  it("fromRead returns the raw string", () => {
    expect(fromRead(col, { new_subject: "Hello world" })).toBe("Hello world");
  });
  it("rejects a non-string", () => {
    expect(() => toWrite(col, 5, "create")).toThrow(/expected a string/);
  });
});

describe("memo", () => {
  const col = baseCol({ logicalName: "new_notes", type: "memo" });
  it("toWrite passes the string through", () => {
    expect(toWrite(col, "long text", "update")).toEqual([["new_notes", "long text"]]);
  });
  it("fromRead returns the raw string", () => {
    expect(fromRead(col, { new_notes: "long text" })).toBe("long text");
  });
});

describe("int", () => {
  const col = baseCol({ logicalName: "new_riskscore", type: "int" });
  it("toWrite accepts an integer", () => {
    expect(toWrite(col, 7, "create")).toEqual([["new_riskscore", 7]]);
  });
  it("fromRead returns the raw number", () => {
    expect(fromRead(col, { new_riskscore: 7 })).toBe(7);
  });
  it("rejects a non-integer number", () => {
    expect(() => toWrite(col, 7.5, "create")).toThrow(/expected an integer/);
  });
});

describe("bigint", () => {
  const col = baseCol({ logicalName: "new_bignum", type: "bigint" });
  it("toWrite accepts a small integer as number", () => {
    expect(toWrite(col, 42, "create")).toEqual([["new_bignum", 42]]);
  });
  it("toWrite sends a numeric string past 2^53 safety as string", () => {
    const big = "9007199254740993"; // > MAX_SAFE_INTEGER
    expect(toWrite(col, big, "create")).toEqual([["new_bignum", big]]);
  });
  it("fromRead returns the raw value", () => {
    expect(fromRead(col, { new_bignum: 42 })).toBe(42);
  });
});

describe("decimal", () => {
  const col = baseCol({ logicalName: "new_decimalfield", type: "decimal" });
  it("toWrite accepts a decimal number", () => {
    expect(toWrite(col, 3.14, "create")).toEqual([["new_decimalfield", 3.14]]);
  });
  it("fromRead returns the raw number", () => {
    expect(fromRead(col, { new_decimalfield: 3.14 })).toBe(3.14);
  });
});

describe("double", () => {
  const col = baseCol({ logicalName: "new_doublefield", type: "double" });
  it("toWrite accepts a number", () => {
    expect(toWrite(col, 2.71828, "create")).toEqual([["new_doublefield", 2.71828]]);
  });
  it("fromRead returns the raw number", () => {
    expect(fromRead(col, { new_doublefield: 2.71828 })).toBe(2.71828);
  });
});

describe("money (no live example — hand-written fixture)", () => {
  const col = baseCol({ logicalName: "new_budget", type: "money" });
  it("toWrite accepts a numeric amount", () => {
    expect(toWrite(col, 1500.5, "create")).toEqual([["new_budget", 1500.5]]);
  });
  it("fromRead returns { value, formatted }", () => {
    expect(
      fromRead(col, {
        new_budget: 1500.5,
        "new_budget@OData.Community.Display.V1.FormattedValue": "$1,500.50",
      }),
    ).toEqual({ value: 1500.5, formatted: "$1,500.50" });
  });
});

describe("boolean", () => {
  const col = baseCol({ logicalName: "new_isactive", type: "boolean" });
  it("toWrite accepts a boolean", () => {
    expect(toWrite(col, true, "create")).toEqual([["new_isactive", true]]);
  });
  it("fromRead returns { value, label }", () => {
    expect(
      fromRead(col, {
        new_isactive: true,
        "new_isactive@OData.Community.Display.V1.FormattedValue": "Yes",
      }),
    ).toEqual({ value: true, label: "Yes" });
  });
  it("rejects a non-boolean", () => {
    expect(() => toWrite(col, "true", "create")).toThrow(/expected a boolean/);
  });
});

describe("dateonly (Format === 'DateOnly', corrected per spec)", () => {
  const raw: RawAttributeMetadata = {
    LogicalName: "msdyn_finish",
    SchemaName: "msdyn_finish",
    AttributeType: "DateTime",
    Format: "DateOnly",
    DateTimeBehavior: { Value: "UserLocal" },
    IsCustomAttribute: true,
    IsValidForCreate: true,
    IsValidForUpdate: true,
  };
  const col = classifyAttribute(raw);

  it("classifies as dateonly from Format, not DateTimeBehavior", () => {
    expect(col.type).toBe("dateonly");
    expect(col.dateFormat).toBe("DateOnly");
  });
  it("toWrite accepts YYYY-MM-DD", () => {
    expect(toWrite(col, "2026-08-01", "create")).toEqual([["msdyn_finish", "2026-08-01"]]);
  });
  it("fromRead returns the raw date string", () => {
    expect(fromRead(col, { msdyn_finish: "2026-08-01" })).toBe("2026-08-01");
  });
  it("rejects a full ISO datetime string", () => {
    expect(() => toWrite(col, "2026-08-01T00:00:00Z", "create")).toThrow(/YYYY-MM-DD/);
  });
});

describe("datetime UserLocal (Format === 'DateAndTime')", () => {
  const raw: RawAttributeMetadata = {
    LogicalName: "createdon",
    SchemaName: "CreatedOn",
    AttributeType: "DateTime",
    Format: "DateAndTime",
    DateTimeBehavior: { Value: "UserLocal" },
    IsCustomAttribute: false,
    IsValidForCreate: false,
    IsValidForUpdate: false,
  };
  const col = classifyAttribute(raw);

  it("classifies as datetime", () => {
    expect(col.type).toBe("datetime");
  });
  it("fromRead returns the ISO string", () => {
    expect(fromRead(col, { createdon: "2026-06-15T10:00:00Z" })).toBe("2026-06-15T10:00:00Z");
  });
});

describe("datetime TimeZoneIndependent (still Format === 'DateAndTime')", () => {
  const raw: RawAttributeMetadata = {
    LogicalName: "msdyn_tzascheduledstart",
    SchemaName: "msdyn_TzaScheduledStart",
    AttributeType: "DateTime",
    Format: "DateAndTime",
    DateTimeBehavior: { Value: "TimeZoneIndependent" },
    IsCustomAttribute: true,
    IsValidForCreate: true,
    IsValidForUpdate: true,
  };
  const col = classifyAttribute(raw);

  it("classifies as datetime (behavior does not affect dateonly decision)", () => {
    expect(col.type).toBe("datetime");
  });
  it("toWrite normalizes to ISO-8601 UTC", () => {
    const [[key, value]] = toWrite(col, "2026-06-15T10:00:00.000Z", "create");
    expect(key).toBe("msdyn_tzascheduledstart");
    expect(value).toBe("2026-06-15T10:00:00.000Z");
  });
  it("rejects an invalid datetime string", () => {
    expect(() => toWrite(col, "not-a-date", "create")).toThrow(/valid ISO-8601/);
  });
});

describe("picklist (project only; values may be in the 192350000 range)", () => {
  const col = baseCol({
    logicalName: "new_category",
    type: "picklist",
    options: [
      { value: 192350000, label: "Fixed effort" },
      { value: 192350001, label: "High" },
    ],
  });
  it("toWrite resolves a label to its integer value", () => {
    expect(toWrite(col, "High", "create")).toEqual([["new_category", 192350001]]);
  });
  it("toWrite accepts an integer value directly", () => {
    expect(toWrite(col, 192350000, "create")).toEqual([["new_category", 192350000]]);
  });
  it("fromRead returns { value, label } from FormattedValue", () => {
    expect(
      fromRead(col, {
        new_category: 192350001,
        "new_category@OData.Community.Display.V1.FormattedValue": "High",
      }),
    ).toEqual({ value: 192350001, label: "High" });
  });
  it("rejects an unknown label with the valid list", () => {
    expect(() => toWrite(col, "Nope", "create")).toThrow(/Fixed effort.*High|High.*Fixed effort/);
  });
  it("rejects an unknown integer value", () => {
    expect(() => toWrite(col, 999, "create")).toThrow(/not a valid option value/);
  });
});

describe("multipicklist (no live example — hand-written fixture)", () => {
  const col = baseCol({
    logicalName: "new_tags",
    type: "multipicklist",
    options: [
      { value: 1, label: "Red" },
      { value: 2, label: "Green" },
      { value: 3, label: "Blue" },
    ],
  });
  it("toWrite joins multiple values into a comma string", () => {
    expect(toWrite(col, [1, "Blue"], "create")).toEqual([["new_tags", "1,3"]]);
  });
  it("toWrite accepts a single scalar value", () => {
    expect(toWrite(col, "Green", "create")).toEqual([["new_tags", "2"]]);
  });
  it("fromRead splits values and labels", () => {
    expect(
      fromRead(col, {
        new_tags: "1,3",
        "new_tags@OData.Community.Display.V1.FormattedValue": "Red,Blue",
      }),
    ).toEqual({ values: [1, 3], labels: ["Red", "Blue"] });
  });
});

describe("lookup (single-target)", () => {
  const col = baseCol({
    logicalName: "new_owningteam",
    type: "lookup",
    navigationProperty: "new_OwningTeam",
    targets: ["team"],
    targetEntitySets: { team: "teams" },
  });
  const guid = "11111111-2222-3333-4444-555555555555";

  it("toWrite resolves nav-property @odata.bind and entity set for the single target", () => {
    expect(toWrite(col, { id: guid }, "create")).toEqual([
      ["new_OwningTeam@odata.bind", `/teams(${guid})`],
    ]);
  });
  it("toWrite accepts a bare guid string when single-target", () => {
    expect(toWrite(col, guid, "create")).toEqual([["new_OwningTeam@odata.bind", `/teams(${guid})`]]);
  });
  it("toWrite validates the guid via assertGuid", () => {
    expect(() => toWrite(col, { id: "not-a-guid" }, "create")).toThrow(/GUID/);
  });
  it("fromRead surfaces id/logicalName/name from annotations", () => {
    expect(
      fromRead(col, {
        _new_owningteam_value: guid,
        "_new_owningteam_value@OData.Community.Display.V1.FormattedValue": "Alpha Team",
        "_new_owningteam_value@Microsoft.Dynamics.CRM.lookuplogicalname": "team",
      }),
    ).toEqual({ id: guid, logicalName: "team", name: "Alpha Team" });
  });
});

describe("customer / polymorphic lookup (no live example — hand-written fixture)", () => {
  const col = baseCol({
    logicalName: "new_billedto",
    type: "customer",
    navigationProperty: "new_BilledTo",
    targets: ["account", "contact"],
    targetEntitySets: { account: "accounts", contact: "contacts" },
  });
  const guid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("toWrite requires an explicit target when polymorphic", () => {
    expect(() => toWrite(col, { id: guid }, "create")).toThrow(/polymorphic/);
  });
  it("toWrite resolves the entity set for the given target", () => {
    expect(toWrite(col, { target: "contact", id: guid }, "create")).toEqual([
      ["new_BilledTo@odata.bind", `/contacts(${guid})`],
    ]);
  });
  it("toWrite rejects a target not in the metadata targets list", () => {
    expect(() => toWrite(col, { target: "team", id: guid }, "create")).toThrow(
      /not valid for this column/,
    );
  });
  it("fromRead uses lookuplogicalname for the polymorphic target entity", () => {
    expect(
      fromRead(col, {
        _new_billedto_value: guid,
        "_new_billedto_value@OData.Community.Display.V1.FormattedValue": guid,
        "_new_billedto_value@Microsoft.Dynamics.CRM.lookuplogicalname": "contact",
      }),
    ).toEqual({ id: guid, logicalName: "contact", name: guid });
  });
});

describe("owner", () => {
  const col = baseCol({
    logicalName: "ownerid",
    type: "owner",
    isCustom: false,
    navigationProperty: "ownerid",
    targets: ["systemuser", "team"],
    targetEntitySets: { systemuser: "systemusers", team: "teams" },
  });
  const guid = "99999999-8888-7777-6666-555555555555";

  it("toWrite resolves systemuser target", () => {
    expect(toWrite(col, { target: "systemuser", id: guid }, "create")).toEqual([
      ["ownerid@odata.bind", `/systemusers(${guid})`],
    ]);
  });
  it("toWrite resolves team target", () => {
    expect(toWrite(col, { target: "team", id: guid }, "create")).toEqual([
      ["ownerid@odata.bind", `/teams(${guid})`],
    ]);
  });
  it("fromRead may have a bare GUID FormattedValue with lookuplogicalname giving the real target", () => {
    expect(
      fromRead(col, {
        _ownerid_value: guid,
        "_ownerid_value@OData.Community.Display.V1.FormattedValue": guid,
        "_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname": "team",
      }),
    ).toEqual({ id: guid, logicalName: "team", name: guid });
  });
});

describe("uniqueidentifier", () => {
  const col = baseCol({ logicalName: "new_externalid", type: "uniqueidentifier" });
  const guid = "12345678-1234-1234-1234-123456789012";
  it("toWrite validates and passes through the GUID", () => {
    expect(toWrite(col, guid, "create")).toEqual([["new_externalid", guid]]);
  });
  it("fromRead returns the raw GUID string", () => {
    expect(fromRead(col, { new_externalid: guid })).toBe(guid);
  });
  it("rejects a non-GUID string", () => {
    expect(() => toWrite(col, "not-a-guid", "create")).toThrow(/GUID/);
  });
});

describe("state — blocked on write (engine/lifecycle-managed)", () => {
  const col = baseCol({ logicalName: "statecode", type: "state", isCustom: false });
  it("toWrite throws", () => {
    expect(() => toWrite(col, 0, "update")).toThrow(/engine\/lifecycle-managed/);
  });
  it("fromRead returns { value, label }", () => {
    expect(
      fromRead(col, {
        statecode: 0,
        "statecode@OData.Community.Display.V1.FormattedValue": "Active",
      }),
    ).toEqual({ value: 0, label: "Active" });
  });
});

describe("status — blocked by default (transition-guarded)", () => {
  const col = baseCol({ logicalName: "statuscode", type: "status", isCustom: false });
  it("toWrite throws", () => {
    expect(() => toWrite(col, 1, "update")).toThrow(/transition-guarded/);
  });
  it("fromRead returns { value, label }", () => {
    expect(
      fromRead(col, {
        statuscode: 1,
        "statuscode@OData.Community.Display.V1.FormattedValue": "Active",
      }),
    ).toEqual({ value: 1, label: "Active" });
  });
});

describe("image — out of scope (no live example — hand-written fixture)", () => {
  const col = baseCol({ logicalName: "new_photo", type: "image" });
  it("toWrite throws with a pointer to the upload endpoint", () => {
    expect(() => toWrite(col, "base64...", "create")).toThrow(/image upload/);
  });
  it("fromRead returns a thumbnail-presence flag only", () => {
    expect(fromRead(col, { new_photo: "somehash" })).toEqual({ hasImage: true });
  });
});

describe("file — out of scope (no live example — hand-written fixture)", () => {
  const col = baseCol({ logicalName: "new_attachment", type: "file" });
  it("toWrite throws with a pointer to the file upload endpoint", () => {
    expect(() => toWrite(col, "somebytes", "create")).toThrow(/file-upload/);
  });
  it("fromRead returns file name/size only", () => {
    expect(
      fromRead(col, { new_attachment_name: "report.pdf", new_attachment_size: 1024 }),
    ).toEqual({ fileName: "report.pdf", fileSize: 1024 });
  });
});

describe("computed columns — rejected on write regardless of type", () => {
  it("SourceType > 0 marks isComputed true and blocks write", () => {
    const raw: RawAttributeMetadata = {
      LogicalName: "new_rollupscore",
      SchemaName: "new_RollupScore",
      AttributeType: "Integer",
      AttributeTypeName: { Value: "IntegerType" },
      IsCustomAttribute: true,
      IsValidForCreate: true,
      IsValidForUpdate: true,
      SourceType: 1,
      AttributeOf: null,
    };
    const col = classifyAttribute(raw);
    expect(col.isComputed).toBe(true);
    expect(() => toWrite(col, 5, "create")).toThrow(/calculated\/rollup/);
  });

  it("AttributeOf != null (derived shadow field, e.g. *name Virtual) marks isComputed true", () => {
    const raw: RawAttributeMetadata = {
      LogicalName: "new_ownername",
      SchemaName: "new_ownername",
      AttributeType: "Virtual",
      AttributeTypeName: { Value: "VirtualType" },
      IsCustomAttribute: true,
      IsValidForCreate: false,
      IsValidForUpdate: false,
      SourceType: null,
      AttributeOf: "new_owner",
    };
    const col = classifyAttribute(raw);
    expect(col.isComputed).toBe(true);
  });

  it("SourceType === 0 is NOT computed", () => {
    const raw: RawAttributeMetadata = {
      LogicalName: "msdyn_subject",
      SchemaName: "msdyn_subject",
      AttributeType: "String",
      AttributeTypeName: { Value: "StringType" },
      IsCustomAttribute: true,
      IsValidForCreate: true,
      IsValidForUpdate: true,
      SourceType: 0,
      AttributeOf: null,
    };
    expect(classifyAttribute(raw).isComputed).toBe(false);
  });

  it("SourceType === null is NOT computed (system/lookup/key column)", () => {
    const raw: RawAttributeMetadata = {
      LogicalName: "msdyn_project",
      SchemaName: "msdyn_project",
      AttributeType: "Lookup",
      AttributeTypeName: { Value: "LookupType" },
      IsCustomAttribute: true,
      IsValidForCreate: true,
      IsValidForUpdate: true,
      SourceType: null,
      AttributeOf: null,
    };
    expect(classifyAttribute(raw).isComputed).toBe(false);
  });
});

describe("IsValidForCreate / IsValidForUpdate boundary", () => {
  it("rejects a create when IsValidForCreate is false", () => {
    const col = baseCol({ logicalName: "new_readonlyfield", isValidForCreate: false });
    expect(() => toWrite(col, "x", "create")).toThrow(/not valid for create/);
  });
  it("rejects an update when IsValidForUpdate is false", () => {
    const col = baseCol({ logicalName: "new_createonlyfield", isValidForUpdate: false });
    expect(() => toWrite(col, "x", "update")).toThrow(/not valid for update/);
  });
});

describe("unsupported / unknown types", () => {
  it("EntityNameType classifies as unsupported", () => {
    const raw: RawAttributeMetadata = {
      LogicalName: "new_ownertype",
      SchemaName: "new_ownertype",
      AttributeType: "EntityName",
      AttributeTypeName: { Value: "EntityNameType" },
      IsCustomAttribute: true,
      IsValidForCreate: false,
      IsValidForUpdate: false,
      AttributeOf: "new_owner",
      SourceType: null,
    };
    const col = classifyAttribute(raw);
    expect(col.type).toBe("unsupported");
    // AttributeOf != null also marks it computed — the computed rejection fires
    // first (a stronger, more specific reason than "type not supported").
    expect(() => toWrite(col, "systemuser", "create")).toThrow(/calculated\/rollup/);
  });

  it("a non-computed unsupported type rejects on write with a 'not supported' message", () => {
    const col = baseCol({ logicalName: "new_unknowntype", type: "unsupported" });
    expect(() => toWrite(col, "x", "create")).toThrow(/not supported/);
  });

  it("unsupported fromRead passes the raw value through", () => {
    const col = baseCol({ logicalName: "new_weird", type: "unsupported" });
    expect(fromRead(col, { new_weird: "raw passthrough" })).toBe("raw passthrough");
  });
});

describe("classifyAttribute — exact shapes from the proven spec", () => {
  it("classifies the representative String attribute JSON", () => {
    const raw: RawAttributeMetadata = {
      LogicalName: "msdyn_subject",
      SchemaName: "msdyn_subject",
      AttributeType: "String",
      AttributeTypeName: { Value: "StringType" },
      IsCustomAttribute: true,
      IsValidForCreate: true,
      IsValidForUpdate: true,
      IsValidForRead: true,
      SourceType: 0,
      AttributeOf: null,
    };
    const col = classifyAttribute(raw);
    expect(col.type).toBe("string");
    expect(col.isCustom).toBe(true);
    expect(col.isComputed).toBe(false);
  });

  it("classifies the Lookup attribute JSON (Owner/Lookup share LookupAttributeMetadata; branch on AttributeType)", () => {
    const rawLookup: RawAttributeMetadata = {
      LogicalName: "msdyn_project",
      SchemaName: "msdyn_project",
      AttributeType: "Lookup",
      AttributeTypeName: { Value: "LookupType" },
      AttributeOf: null,
      SourceType: null,
      IsCustomAttribute: true,
      IsValidForCreate: true,
      IsValidForUpdate: true,
      IsValidForRead: true,
    };
    expect(classifyAttribute(rawLookup).type).toBe("lookup");

    const rawOwner: RawAttributeMetadata = {
      LogicalName: "ownerid",
      SchemaName: "ownerid",
      AttributeType: "Owner",
      AttributeTypeName: { Value: "OwnerType" },
      AttributeOf: null,
      SourceType: null,
      IsCustomAttribute: false,
      IsValidForCreate: true,
      IsValidForUpdate: true,
      IsValidForRead: true,
    };
    expect(classifyAttribute(rawOwner).type).toBe("owner");
  });

  it("IsCustomAttribute is carried as a hint but is NOT the type/computed decision", () => {
    // Standard msdyn_ field reporting IsCustomAttribute:true (proven live) —
    // classification must not treat this as license to write it via this path;
    // that gate lives in the metadata/prefix layer, not here.
    const raw: RawAttributeMetadata = {
      LogicalName: "msdyn_priority",
      SchemaName: "msdyn_priority",
      AttributeType: "Picklist",
      AttributeTypeName: { Value: "PicklistType" },
      IsCustomAttribute: true,
      IsValidForCreate: true,
      IsValidForUpdate: true,
      SourceType: 0,
      AttributeOf: null,
    };
    const col = classifyAttribute(raw);
    expect(col.isCustom).toBe(true);
    expect(col.type).toBe("picklist");
    // classifyAttribute does not know about prefix discipline; that's enforced
    // by the metadata layer (Phase 2), which only classifies non-msdyn_ columns
    // as eligible in the first place.
  });
});
