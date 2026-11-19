// graphql.ts - a deliberately small GraphQL v4 implementation.  It parses
// queries/mutations, resolves the fields used by gh and github-mcp-server, and
// exposes enough introspection to describe the forge's types.  Unknown fields
// produce a normal GraphQL `errors` array (HTTP 200), not an HTTP error.

import type { Ctx } from "./api.ts";
import { authorized, sendError, sendJson } from "./api.ts";
import { pullMergeable, type Forge, type Issue, type Label, type Pull, type Repo, type User } from "./meta.ts";

// ---------------------------------------------------------------------------
// Query language parser

type GqlValue =
  | { kind: "var"; name: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "list"; values: GqlValue[] }
  | { kind: "object"; fields: Record<string, GqlValue> };

interface GqlField {
  alias?: string;
  name: string;
  args: Record<string, GqlValue>;
  selections?: GqlSelection[];
}

type GqlSelection =
  | { kind: "field"; field: GqlField }
  | { kind: "spread"; name: string }
  | { kind: "inline"; typeName?: string; selections: GqlSelection[] };

interface GqlOperation {
  operation: "query" | "mutation" | "subscription";
  name?: string;
  selections: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeName: string; selections: GqlSelection[] }>;
}

class Parser {
  private i = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeName: string; selections: GqlSelection[] }>();
    this.skip();
    while (this.i < this.src.length) {
      if (this.peek() === "{") {
        operations.push({ operation: "query", selections: this.parseSelectionSet() });
      } else {
        const keyword = this.readName();
        if (keyword === "query" || keyword === "mutation" || keyword === "subscription") {
          let name: string | undefined;
          this.skip();
          if (this.peek() !== "(" && this.peek() !== "{" && this.peek() !== "@") {
            name = this.readName();
          }
          this.skip();
          if (this.peek() === "(") this.skipBalanced("(", ")");
          this.skipDirectives();
          const selections = this.parseSelectionSet();
          operations.push({ operation: keyword, name, selections });
        } else if (keyword === "fragment") {
          const name = this.readName();
          this.skip();
          this.readName(); // "on"
          this.skip();
          const typeName = this.readName();
          this.skipDirectives();
          const selections = this.parseSelectionSet();
          fragments.set(name, { typeName, selections });
        } else {
          throw new Error("unexpected token: " + keyword);
        }
      }
      this.skip();
    }
    return { operations, fragments };
  }

  private skip(): void {
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "," || c === "\ufeff") {
        this.i++;
      } else if (c === "#") {
        while (this.i < this.src.length && this.src[this.i] !== "\n") this.i++;
      } else {
        break;
      }
    }
  }

  private peek(): string {
    return this.src[this.i] ?? "";
  }

  private expect(ch: string): void {
    this.skip();
    if (this.src[this.i] !== ch) throw new Error("expected " + ch);
    this.i++;
  }

  private readName(): string {
    this.skip();
    const start = this.i;
    while (this.i < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.i])) this.i++;
    if (this.i === start) throw new Error("expected name");
    return this.src.slice(start, this.i);
  }

  private skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (this.i < this.src.length && depth > 0) {
      const c = this.src[this.i];
      if (c === '"') {
        this.parseString();
        continue;
      }
      if (c === open) depth++;
      else if (c === close) depth--;
      this.i++;
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect("{");
    const out: GqlSelection[] = [];
    while (true) {
      this.skip();
      if (this.peek() === "}") {
        this.i++;
        break;
      }
      if (this.peek() === "") throw new Error("unterminated selection set");
      if (this.src.startsWith("...", this.i)) {
        this.i += 3;
        this.skip();
        if (this.src.startsWith("on", this.i) && !/[A-Za-z0-9_]/.test(this.src[this.i + 2] ?? "")) {
          this.i += 2;
          this.skip();
          const typeName = this.readName();
          this.skipDirectives();
          out.push({ kind: "inline", typeName, selections: this.parseSelectionSet() });
        } else if (this.peek() === "{") {
          out.push({ kind: "inline", selections: this.parseSelectionSet() });
        } else {
          const name = this.readName();
          this.skipDirectives();
          out.push({ kind: "spread", name });
        }
        continue;
      }
      let name = this.readName();
      let alias: string | undefined;
      this.skip();
      if (this.peek() === ":") {
        this.i++;
        alias = name;
        name = this.readName();
      }
      const args = this.parseArguments();
      this.skipDirectives();
      let selections: GqlSelection[] | undefined;
      this.skip();
      if (this.peek() === "{") selections = this.parseSelectionSet();
      out.push({ kind: "field", field: { alias, name, args, selections } });
    }
    return out;
  }

  private parseArguments(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    this.skip();
    if (this.peek() !== "(") return args;
    this.i++;
    while (true) {
      this.skip();
      if (this.peek() === ")") {
        this.i++;
        break;
      }
      const name = this.readName();
      this.expect(":");
      this.skip();
      args[name] = this.parseValue();
      this.skip();
    }
    return args;
  }

  private skipDirectives(): void {
    while (true) {
      this.skip();
      if (this.peek() !== "@") return;
      this.i++;
      this.readName();
      this.skip();
      if (this.peek() === "(") this.parseArguments();
    }
  }

  private parseValue(): GqlValue {
    this.skip();
    const c = this.peek();
    if (c === "$") {
      this.i++;
      return { kind: "var", name: this.readName() };
    }
    if (c === '"') return { kind: "string", value: this.parseString() };
    if (c === "[") {
      this.i++;
      const values: GqlValue[] = [];
      while (true) {
        this.skip();
        if (this.peek() === "]") {
          this.i++;
          break;
        }
        values.push(this.parseValue());
        this.skip();
      }
      return { kind: "list", values };
    }
    if (c === "{") {
      this.i++;
      const fields: Record<string, GqlValue> = {};
      while (true) {
        this.skip();
        if (this.peek() === "}") {
          this.i++;
          break;
        }
        const name = this.readName();
        this.expect(":");
        this.skip();
        fields[name] = this.parseValue();
        this.skip();
      }
      return { kind: "object", fields };
    }
    if (c === "-" || /[0-9]/.test(c)) {
      const start = this.i;
      if (c === "-") this.i++;
      while (this.i < this.src.length && /[0-9.eE+-]/.test(this.src[this.i])) this.i++;
      return { kind: "number", value: Number(this.src.slice(start, this.i)) };
    }
    const name = this.readName();
    if (name === "true") return { kind: "bool", value: true };
    if (name === "false") return { kind: "bool", value: false };
    if (name === "null") return { kind: "null" };
    return { kind: "enum", value: name };
  }

  private parseString(): string {
    this.expect('"');
    if (this.src.startsWith('""', this.i)) {
      this.i += 2;
      const start = this.i;
      const end = this.src.indexOf('"""', this.i);
      const text = end >= 0 ? this.src.slice(start, end) : this.src.slice(start);
      this.i = end >= 0 ? end + 3 : this.src.length;
      return text;
    }
    let out = "";
    while (this.i < this.src.length) {
      const c = this.src[this.i++];
      if (c === '"') break;
      if (c === "\\") {
        const n = this.src[this.i++];
        if (n === "n") out += "\n";
        else if (n === "r") out += "\r";
        else if (n === "t") out += "\t";
        else if (n === "b") out += "\b";
        else if (n === "f") out += "\f";
        else if (n === "u") {
          const hex = this.src.slice(this.i, this.i + 4);
          this.i += 4;
          out += String.fromCharCode(parseInt(hex, 16));
        } else out += n;
      } else {
        out += c;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Tiny schema description used for execution and introspection

interface ArgDef {
  name: string;
  typeName: string;
  list?: boolean;
  description?: string;
}

interface FieldDef {
  name: string;
  typeName: string;
  list?: boolean;
  args?: ArgDef[];
  description?: string;
}

interface TypeDef {
  kind: "OBJECT" | "ENUM" | "SCALAR" | "INPUT_OBJECT" | "INTERFACE" | "UNION";
  description?: string;
  fields?: FieldDef[];
  enumValues?: string[];
  inputFields?: FieldDef[];
}

const arg = (name: string, typeName: string, list = false): ArgDef => ({ name, typeName, list });
const field = (name: string, typeName: string, list = false, args?: ArgDef[]): FieldDef => ({
  name,
  typeName,
  list,
  args,
});

const TYPES: Record<string, TypeDef> = {
  Query: {
    kind: "OBJECT",
    fields: [
      field("repository", "Repository", false, [arg("owner", "String"), arg("name", "String")]),
      field("viewer", "User"),
      field("user", "User", false, [arg("login", "String")]),
      field("node", "Node", false, [arg("id", "ID")]),
      field("search", "SearchResultItemConnection", false, [
        arg("query", "String"),
        arg("type", "SearchType"),
        arg("first", "Int"),
        arg("after", "String"),
      ]),
      field("__type", "__Type", false, [arg("name", "String")]),
      field("__schema", "__Schema"),
    ],
  },
  Mutation: {
    kind: "OBJECT",
    fields: [
      field("createPullRequest", "CreatePullRequestPayload", false, [arg("input", "CreatePullRequestInput")]),
      field("createIssue", "CreateIssuePayload", false, [arg("input", "CreateIssueInput")]),
      field("mergePullRequest", "MergePullRequestPayload", false, [arg("input", "MergePullRequestInput")]),
      field("closeIssue", "CloseIssuePayload", false, [arg("input", "CloseIssueInput")]),
      field("addComment", "AddCommentPayload", false, [arg("input", "AddCommentInput")]),
    ],
  },
  CloseIssuePayload: {
    kind: "OBJECT",
    fields: [field("issue", "Issue"), field("clientMutationId", "String")],
  },
  AddCommentPayload: {
    kind: "OBJECT",
    fields: [field("commentEdge", "CommentEdge"), field("clientMutationId", "String")],
  },
  CommentEdge: { kind: "OBJECT", fields: [field("node", "IssueComment")] },
  CloseIssueInput: { kind: "INPUT_OBJECT", inputFields: [field("issueId", "ID")] },
  AddCommentInput: { kind: "INPUT_OBJECT", inputFields: [field("subjectId", "ID"), field("body", "String")] },
  Repository: {
    kind: "OBJECT",
    fields: [
      field("id", "ID"),
      field("databaseId", "Int"),
      field("name", "String"),
      field("nameWithOwner", "String"),
      field("owner", "User"),
      field("defaultBranchRef", "Ref"),
      field("viewerPermission", "String"),
      field("hasIssuesEnabled", "Boolean"),
      field("issue", "Issue", false, [arg("number", "Int")]),
      field("issues", "IssueConnection", false, [
        arg("first", "Int"),
        arg("last", "Int"),
        arg("after", "String"),
        arg("orderBy", "IssueOrder"),
        arg("filterBy", "IssueFilters"),
        arg("states", "IssueState", true),
      ]),
      field("pullRequests", "PullRequestConnection", false, [
        arg("first", "Int"),
        arg("last", "Int"),
        arg("after", "String"),
        arg("states", "PullRequestState", true),
      ]),
      field("pullRequest", "PullRequest", false, [arg("number", "Int")]),
      field("description", "String"),
      field("isPrivate", "Boolean"),
      field("isFork", "Boolean"),
      field("isArchived", "Boolean"),
      field("createdAt", "String"),
      field("updatedAt", "String"),
      field("url", "String"),
      field("ref", "Ref", false, [arg("qualifiedName", "String")]),
      field("object", "GitObject", false, [arg("expression", "String")]),
      field("commit", "Commit", false, [arg("expression", "String")]),
      field("branches", "RefConnection"),
    ],
  },
  Issue: {
    kind: "OBJECT",
    fields: [
      field("id", "ID"),
      field("number", "Int"),
      field("title", "String"),
      field("state", "String"),
      field("body", "String"),
      field("createdAt", "String"),
      field("updatedAt", "String"),
      field("closed", "Boolean"),
      field("closedAt", "String"),
      field("author", "User"),
      field("user", "User"),
      field("labels", "LabelConnection", false, [arg("first", "Int")]),
      field("url", "String"),
      field("repository", "Repository"),
      field("comments", "CommentConnection", false, [arg("first", "Int")]),
      field("isPinned", "Boolean"),
      field("__typename", "String"),
    ],
  },
  PullRequest: {
    kind: "OBJECT",
    fields: [
      field("id", "ID"),
      field("number", "Int"),
      field("title", "String"),
      field("state", "String"),
      field("body", "String"),
      field("merged", "Boolean"),
      field("mergeable", "String"),
      field("mergedAt", "String"),
      field("createdAt", "String"),
      field("updatedAt", "String"),
      field("headRefName", "String"),
      field("baseRefName", "String"),
      field("headRefOid", "String"),
      field("baseRefOid", "String"),
      field("headRepository", "Repository"),
      field("baseRepository", "Repository"),
      field("files", "PullRequestChangedFileConnection", false, [arg("first", "Int")]),
      field("commits", "CommitConnection", false, [arg("first", "Int")]),
      field("author", "User"),
      field("mergedBy", "User"),
      field("mergeCommit", "Commit"),
      field("isDraft", "Boolean"),
      field("additions", "Int"),
      field("deletions", "Int"),
      field("changedFiles", "Int"),
      field("url", "String"),
      field("repository", "Repository"),
    ],
  },
  User: {
    kind: "OBJECT",
    fields: [
      field("id", "ID"),
      field("databaseId", "Int"),
      field("login", "String"),
      field("name", "String"),
      field("email", "String"),
      field("url", "String"),
      field("avatarUrl", "String"),
    ],
  },
  Label: {
    kind: "OBJECT",
    fields: [
      field("id", "ID"),
      field("name", "String"),
      field("color", "String"),
      field("description", "String"),
    ],
  },
  Ref: {
    kind: "OBJECT",
    fields: [
      field("name", "String"),
      field("prefix", "String"),
      field("target", "GitObject"),
      field("repository", "Repository"),
    ],
  },
  Commit: {
    kind: "OBJECT",
    fields: [
      field("id", "ID"),
      field("oid", "String"),
      field("abbreviatedOid", "String"),
      field("message", "String"),
      field("messageHeadline", "String"),
      field("committedDate", "String"),
      field("author", "GitActor"),
      field("committer", "GitActor"),
      field("tree", "Tree"),
      field("parents", "CommitConnection"),
      field("url", "String"),
    ],
  },
  GitActor: {
    kind: "OBJECT",
    fields: [field("name", "String"), field("email", "String"), field("user", "User")],
  },
  Tree: {
    kind: "OBJECT",
    fields: [field("oid", "String"), field("entries", "TreeEntry", true)],
  },
  TreeEntry: {
    kind: "OBJECT",
    fields: [field("name", "String"), field("type", "String"), field("oid", "String"), field("mode", "Int")],
  },
  Blob: {
    kind: "OBJECT",
    fields: [field("oid", "String"), field("text", "String"), field("isBinary", "Boolean")],
  },
  IssueConnection: {
    kind: "OBJECT",
    fields: [
      field("nodes", "Issue", true),
      field("edges", "IssueEdge", true),
      field("totalCount", "Int"),
      field("pageInfo", "PageInfo"),
    ],
  },
  IssueEdge: { kind: "OBJECT", fields: [field("node", "Issue"), field("cursor", "String")] },
  PullRequestConnection: {
    kind: "OBJECT",
    fields: [
      field("nodes", "PullRequest", true),
      field("edges", "PullRequestEdge", true),
      field("totalCount", "Int"),
      field("pageInfo", "PageInfo"),
    ],
  },
  PullRequestEdge: { kind: "OBJECT", fields: [field("node", "PullRequest"), field("cursor", "String")] },
  LabelConnection: {
    kind: "OBJECT",
    fields: [
      field("nodes", "Label", true),
      field("edges", "LabelEdge", true),
      field("totalCount", "Int"),
      field("pageInfo", "PageInfo"),
    ],
  },
  LabelEdge: { kind: "OBJECT", fields: [field("node", "Label"), field("cursor", "String")] },
  CommentConnection: {
    kind: "OBJECT",
    fields: [
      field("nodes", "IssueComment", true),
      field("edges", "IssueCommentEdge", true),
      field("totalCount", "Int"),
      field("pageInfo", "PageInfo"),
    ],
  },
  IssueComment: { kind: "OBJECT", fields: [field("id", "ID"), field("body", "String"), field("author", "User")] },
  IssueCommentEdge: { kind: "OBJECT", fields: [field("node", "IssueComment"), field("cursor", "String")] },
  CommitConnection: {
    kind: "OBJECT",
    fields: [
      field("nodes", "Commit", true),
      field("edges", "CommitEdge", true),
      field("totalCount", "Int"),
      field("pageInfo", "PageInfo"),
    ],
  },
  CommitEdge: { kind: "OBJECT", fields: [field("node", "Commit"), field("cursor", "String")] },
  PullRequestChangedFileConnection: {
    kind: "OBJECT",
    fields: [
      field("nodes", "PullRequestChangedFile", true),
      field("edges", "PullRequestChangedFileEdge", true),
      field("totalCount", "Int"),
      field("pageInfo", "PageInfo"),
    ],
  },
  PullRequestChangedFile: {
    kind: "OBJECT",
    fields: [
      field("path", "String"),
      field("additions", "Int"),
      field("deletions", "Int"),
      field("changeType", "String"),
    ],
  },
  PullRequestChangedFileEdge: {
    kind: "OBJECT",
    fields: [field("node", "PullRequestChangedFile"), field("cursor", "String")],
  },
  RefConnection: {
    kind: "OBJECT",
    fields: [
      field("nodes", "Ref", true),
      field("edges", "RefEdge", true),
      field("totalCount", "Int"),
      field("pageInfo", "PageInfo"),
    ],
  },
  RefEdge: { kind: "OBJECT", fields: [field("node", "Ref"), field("cursor", "String")] },
  PageInfo: {
    kind: "OBJECT",
    fields: [
      field("hasNextPage", "Boolean"),
      field("hasPreviousPage", "Boolean"),
      field("startCursor", "String"),
      field("endCursor", "String"),
    ],
  },
  SearchResultItemConnection: {
    kind: "OBJECT",
    fields: [
      field("nodes", "SearchResultItem", true),
      field("edges", "SearchResultItemEdge", true),
      field("totalCount", "Int"),
      field("issueCount", "Int"),
      field("pageInfo", "PageInfo"),
    ],
  },
  SearchResultItemEdge: {
    kind: "OBJECT",
    fields: [field("node", "SearchResultItem"), field("cursor", "String")],
  },
  CreatePullRequestInput: {
    kind: "INPUT_OBJECT",
    inputFields: [
      field("repositoryId", "ID"),
      field("headRefName", "String"),
      field("baseRefName", "String"),
      field("title", "String"),
      field("body", "String"),
      field("draft", "Boolean"),
    ],
  },
  CreatePullRequestPayload: {
    kind: "OBJECT",
    fields: [field("pullRequest", "PullRequest"), field("clientMutationId", "String")],
  },
  CreateIssueInput: {
    kind: "INPUT_OBJECT",
    inputFields: [
      field("repositoryId", "ID"),
      field("title", "String"),
      field("body", "String"),
      field("labelIds", "ID", true),
    ],
  },
  CreateIssuePayload: {
    kind: "OBJECT",
    fields: [field("issue", "Issue"), field("clientMutationId", "String")],
  },
  MergePullRequestInput: {
    kind: "INPUT_OBJECT",
    inputFields: [
      field("pullRequestId", "ID"),
      field("mergeMethod", "String"),
    ],
  },
  MergePullRequestPayload: {
    kind: "OBJECT",
    fields: [field("pullRequest", "PullRequest"), field("clientMutationId", "String")],
  },
  IssueOrder: {
    kind: "INPUT_OBJECT",
    inputFields: [field("field", "String"), field("direction", "String")],
  },
  IssueFilters: {
    kind: "INPUT_OBJECT",
    inputFields: [field("states", "IssueState", true), field("labels", "String", true)],
  },
  SearchType: {
    kind: "ENUM",
    enumValues: ["ISSUE", "REPOSITORY", "USER", "DISCUSSION"],
  },
  SearchResultItem: { kind: "UNION", fields: [] },
  Node: { kind: "INTERFACE", fields: [field("id", "ID")] },
  GitObject: { kind: "INTERFACE", fields: [field("oid", "String")] },
  __Schema: {
    kind: "OBJECT",
    fields: [
      field("description", "String"),
      field("types", "__Type", true),
      field("queryType", "__Type"),
      field("mutationType", "__Type"),
      field("subscriptionType", "__Type"),
      field("directives", "__Directive", true),
    ],
  },
  __Type: {
    kind: "OBJECT",
    fields: [
      field("kind", "String"),
      field("name", "String"),
      field("description", "String"),
      field("fields", "__Field", true, [arg("includeDeprecated", "Boolean")]),
      field("inputFields", "__InputValue", true),
      field("interfaces", "__Type", true),
      field("possibleTypes", "__Type", true),
      field("enumValues", "__EnumValue", true, [arg("includeDeprecated", "Boolean")]),
      field("ofType", "__Type"),
      field("specifiedByURL", "String"),
    ],
  },
  __Field: {
    kind: "OBJECT",
    fields: [
      field("name", "String"),
      field("description", "String"),
      field("args", "__InputValue", true),
      field("type", "__Type"),
      field("isDeprecated", "Boolean"),
      field("deprecationReason", "String"),
    ],
  },
  __InputValue: {
    kind: "OBJECT",
    fields: [
      field("name", "String"),
      field("description", "String"),
      field("type", "__Type"),
      field("defaultValue", "String"),
    ],
  },
  __EnumValue: {
    kind: "OBJECT",
    fields: [
      field("name", "String"),
      field("description", "String"),
      field("isDeprecated", "Boolean"),
      field("deprecationReason", "String"),
    ],
  },
  __Directive: {
    kind: "OBJECT",
    fields: [
      field("name", "String"),
      field("description", "String"),
      field("locations", "String", true),
      field("args", "__InputValue", true),
    ],
  },
};

const SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

function typeRef(typeName: string, list = false): any {
  if (list) {
    return { __type: "__Type", kind: "LIST", name: null, ofType: typeRef(typeName, false) };
  }
  const def = TYPES[typeName];
  const kind = SCALARS.has(typeName)
    ? "SCALAR"
    : def?.kind === "ENUM"
      ? "ENUM"
      : def?.kind === "INPUT_OBJECT"
        ? "INPUT_OBJECT"
        : def?.kind === "INTERFACE"
          ? "INTERFACE"
          : def?.kind === "UNION"
            ? "UNION"
            : "OBJECT";
  return { __type: "__Type", kind, name: typeName, ofType: null };
}

function introspectType(name: string): any {
  const def = TYPES[name];
  if (!def) return null;
  const fields = def.fields?.map((fd) => ({
    __type: "__Field",
    name: fd.name,
    description: fd.description ?? "",
    args: (fd.args ?? []).map((a) => ({
      __type: "__InputValue",
      name: a.name,
      description: a.description ?? "",
      type: typeRef(a.typeName, a.list),
      defaultValue: null,
    })),
    type: typeRef(fd.typeName, fd.list),
    isDeprecated: false,
    deprecationReason: null,
  }));
  const inputFields = def.inputFields?.map((fd) => ({
    __type: "__InputValue",
    name: fd.name,
    description: fd.description ?? "",
    type: typeRef(fd.typeName, fd.list),
    defaultValue: null,
  }));
  const enumValues = def.enumValues?.map((v) => ({
    __type: "__EnumValue",
    name: v,
    description: "",
    isDeprecated: false,
    deprecationReason: null,
  }));
  return {
    __type: "__Type",
    kind: def.kind,
    name,
    description: def.description ?? "",
    fields: fields ?? null,
    inputFields: inputFields ?? null,
    interfaces: [],
    possibleTypes: [],
    enumValues: enumValues ?? null,
    ofType: null,
    specifiedByURL: null,
  };
}

function schemaDescriptor(): any {
  const names = Object.keys(TYPES).sort();
  return {
    __type: "__Schema",
    description: "ghforge GraphQL schema",
    types: names.map(introspectType),
    queryType: introspectType("Query"),
    mutationType: introspectType("Mutation"),
    subscriptionType: null,
    directives: [],
  };
}

// ---------------------------------------------------------------------------
// Execution

interface Env {
  forge: Forge;
  login: string;
  vars: Record<string, any>;
  fragments: Map<string, { typeName: string; selections: GqlSelection[] }>;
  errors: Array<{ message: string }>;
}

function valueOf(v: GqlValue | undefined, vars: Record<string, any>): any {
  if (!v) return undefined;
  switch (v.kind) {
    case "var":
      return vars[v.name];
    case "string":
    case "number":
    case "bool":
    case "enum":
      return v.value;
    case "null":
      return null;
    case "list":
      return v.values.map((x) => valueOf(x, vars));
    case "object": {
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = valueOf(val, vars);
      return out;
    }
  }
}

function globalId(kind: string, id: number): string {
  // Relay's opaque global id: base64("<TypeName>:<numeric id>").
  const typeName = { R: "Repository", I: "Issue", PR: "PullRequest", C: "IssueComment" }[kind] ?? "Node";
  return Buffer.from(`${typeName}:${id}`, "utf8").toString("base64");
}

function decodeGlobalId(value: any): { kind: string; id: number } | undefined {
  if (typeof value !== "string") return undefined;
  const candidates = [value];
  try {
    candidates.push(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    // ignore
  }
  for (const c of candidates) {
    // Relay global ids are base64("<Type>:<number>"), e.g. "UmVwb3NpdG9yeTox" for Repository:1.
    const m = /^(?:Repository|Issue|PullRequest|IssueComment):(\d+)$/i.exec(c);
    if (m) {
      const kind = { Repository: "R", Issue: "I", PullRequest: "PR", IssueComment: "C" }[c.split(":")[0]] as string;
      return { kind, id: Number(m[1]) };
    }
    const legacy = /^(R|I|PR|C)_(\d+)$/.exec(c);
    if (legacy) return { kind: legacy[1], id: Number(legacy[2]) };
  }
  if (/^\d+$/.test(value)) return { kind: "R", id: Number(value) };
  return undefined;
}

function repoFromGlobal(forge: Forge, value: any): Repo | undefined {
  const decoded = decodeGlobalId(value);
  if (!decoded || decoded.kind !== "R") return undefined;
  for (const repo of forge.repos.values()) {
    if (repo.id === decoded.id) return repo;
  }
  return undefined;
}

function userObj(user: User): any {
  return { __type: "User", data: user };
}

function labelObj(label: Label): any {
  return { __type: "Label", data: label };
}

function repoObj(repo: Repo): any {
  return { __type: "Repository", data: repo };
}

function issueObj(issue: Issue): any {
  return { __type: "Issue", data: issue };
}

function pullObj(pull: Pull): any {
  return { __type: "PullRequest", data: pull };
}

function connection(items: any[], totalCount = items.length, hasNextPage?: boolean): any {
  return {
    __type: "Connection",
    items,
    totalCount,
    pageInfo: {
      __type: "PageInfo",
      hasNextPage: hasNextPage ?? items.length < totalCount,
      hasPreviousPage: false,
      startCursor: items.length ? "0" : null,
      endCursor: items.length ? String(items.length - 1) : null,
    },
  };
}

function sortIssues(items: Issue[], orderBy: any): Issue[] {
  const direction = orderBy && orderBy.direction === "ASC" ? "ASC" : "DESC";
  const fieldName = orderBy && orderBy.field ? String(orderBy.field) : "CREATED_AT";
  const out = items.slice();
  out.sort((a, b) => {
    const av = fieldName === "UPDATED_AT" ? a.updatedAt : a.createdAt;
    const bv = fieldName === "UPDATED_AT" ? b.updatedAt : b.createdAt;
    let cmp = av < bv ? -1 : av > bv ? 1 : 0;
    if (cmp === 0) cmp = a.number - b.number;
    return direction === "ASC" ? cmp : -cmp;
  });
  return out;
}

function pullFiles(pull: Pull): any[] {
  const repo = pull.repo;
  const baseSha = repo.store.getRef("refs/heads/" + pull.baseRef);
  const headSha = repo.store.getRef("refs/heads/" + pull.headRef);
  if (!baseSha || !headSha) return [];
  const baseTree = repo.store.commitTree(baseSha);
  const headTree = repo.store.commitTree(headSha);
  if (!baseTree || !headTree) return [];
  const { readTreeFlat } = requireStore();
  const baseFiles = readTreeFlat(repo.store, baseTree);
  const headFiles = readTreeFlat(repo.store, headTree);
  const paths = new Set<string>();
  for (const p of baseFiles.keys()) paths.add(p);
  for (const p of headFiles.keys()) paths.add(p);
  const out: any[] = [];
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b?.sha === h?.sha && b?.mode === h?.mode) continue;
    out.push({
      __type: "PullRequestChangedFile",
      path,
      additions: 0,
      deletions: 0,
      changeType: !b ? "ADDED" : !h ? "DELETED" : "MODIFIED",
    });
  }
  return out;
}

// A tiny indirection avoids a cycle at module initialization time on some
// Node versions; readTreeFlat has no state of its own.
import { readTreeFlat as readTreeFlatImpl } from "./store.ts";
function requireStore() {
  return { readTreeFlat: readTreeFlatImpl };
}

function resolveQuery(fld: GqlField, env: Env): any {
  const args = (name: string) => valueOf(fld.args[name], env.vars);
  switch (fld.name) {
    case "repository": {
      const owner = String(args("owner") ?? "");
      const name = String(args("name") ?? "");
      const repo = env.forge.getRepo(owner, name);
      return repo ? repoObj(repo) : null;
    }
    case "viewer":
      return userObj(env.forge.ensureUser(env.login));
    case "user": {
      const login = String(args("login") ?? "");
      const user = env.forge.getUser(login);
      return user ? userObj(user) : null;
    }
    case "node": {
      const decoded = decodeGlobalId(args("id"));
      if (!decoded) return null;
      if (decoded.kind === "R") {
        const repo = repoFromGlobal(env.forge, args("id"));
        return repo ? repoObj(repo) : null;
      }
      for (const repo of env.forge.repos.values()) {
        if (decoded.kind === "I") {
          for (const issue of repo.issues.values()) if (issue.id === decoded.id) return issueObj(issue);
        }
        if (decoded.kind === "PR") {
          for (const pull of repo.pulls.values()) if (pull.id === decoded.id) return pullObj(pull);
        }
      }
      return null;
    }
    case "search": {
      const type = String(args("type") ?? "ISSUE");
      const text = String(args("query") ?? "").toLowerCase();
      const first = Number(args("first") ?? 100);
      const items: any[] = [];
      for (const repo of env.forge.repos.values()) {
        if (type === "ISSUE") {
          for (const issue of repo.issues.values()) {
            if (!text || issue.title.toLowerCase().includes(text) || issue.body.toLowerCase().includes(text)) {
              items.push(issueObj(issue));
            }
          }
        } else if (type === "REPOSITORY") {
          if (!text || (repo.owner + "/" + repo.name).toLowerCase().includes(text)) items.push(repoObj(repo));
        }
      }
      const slice = items.slice(0, Number.isFinite(first) ? first : 100);
      const conn = connection(slice, items.length);
      conn.issueCount = type === "ISSUE" ? items.length : 0;
      return conn;
    }
    case "__type":
      return introspectType(String(args("name") ?? ""));
    case "__schema":
      return schemaDescriptor();
    default:
      return null;
  }
}

function resolveMutation(fld: GqlField, env: Env): any {
  const input = valueOf(fld.args.input, env.vars) || {};
  if (fld.name === "createPullRequest") {
    const repo = repoFromGlobal(env.forge, input.repositoryId);
    if (!repo) return { __type: "CreatePullRequestPayload", pullRequest: null };
    const title = typeof input.title === "string" ? input.title : "Pull request";
    const body = typeof input.body === "string" ? input.body : "";
    const head = typeof input.headRefName === "string" ? input.headRefName : "";
    const base = typeof input.baseRefName === "string" ? input.baseRefName : repo.defaultBranch;
    const pull = env.forge.createPull(repo, title, body, head, base, env.login);
    return { __type: "CreatePullRequestPayload", pullRequest: pullObj(pull) };
  }
  if (fld.name === "createIssue") {
    const repo = repoFromGlobal(env.forge, input.repositoryId);
    if (!repo) return { __type: "CreateIssuePayload", issue: null };
    const title = typeof input.title === "string" ? input.title : "";
    const body = typeof input.body === "string" ? input.body : "";
    const issue = env.forge.createIssue(repo, title, body, [], env.login);
    return { __type: "CreateIssuePayload", issue: issueObj(issue) };
  }
  if (fld.name === "mergePullRequest") {
    const decoded = decodeGlobalId(input.pullRequestId);
    if (!decoded || decoded.kind !== "PR") return { __type: "MergePullRequestPayload", pullRequest: null };
    for (const repo of env.forge.repos.values()) {
      for (const pull of repo.pulls.values()) {
        if (pull.id === decoded.id) {
          env.forge.mergePull(repo, pull);
          return { __type: "MergePullRequestPayload", pullRequest: pullObj(pull) };
        }
      }
    }
  }
  if (fld.name === "closeIssue") {
    const decoded = decodeGlobalId(input.issueId);
    if (!decoded || decoded.kind !== "I") return { __type: "CloseIssuePayload", issue: null };
    for (const repo of env.forge.repos.values()) {
      const issue = repo.issues.get(decoded.id) ?? [...repo.issues.values()].find((i) => i.id === decoded.id);
      if (issue) {
        issue.state = "closed";
        issue.updatedAt = new Date().toISOString();
        return { __type: "CloseIssuePayload", issue: issueObj(issue) };
      }
    }
    return { __type: "CloseIssuePayload", issue: null };
  }
  if (fld.name === "addComment") {
    const decoded = decodeGlobalId(input.subjectId);
    const body = typeof input.body === "string" ? input.body : "";
    if (!decoded || body === "") return { __type: "AddCommentPayload", commentEdge: null };
    for (const repo of env.forge.repos.values()) {
      const issue = [...repo.issues.values()].find((i) => i.id === decoded.id);
      if (issue) {
        const comment = env.forge.addIssueComment(repo, issue, body, env.login);
        return { __type: "AddCommentPayload", commentEdge: { node: { __type: "IssueComment", data: comment } } };
      }
    }
    return { __type: "AddCommentPayload", commentEdge: null };
  }
  return null;
}

function resolveRepository(fld: GqlField, obj: any, env: Env): any {
  const repo: Repo = obj.data;
  const args = (name: string) => valueOf(fld.args[name], env.vars);
  switch (fld.name) {
    case "id":
      return globalId("R", repo.id);
    case "databaseId":
      return repo.id;
    case "name":
      return repo.name;
    case "nameWithOwner":
      return repo.owner + "/" + repo.name;
    case "owner":
      return userObj(env.forge.ensureUser(repo.owner));
    case "defaultBranchRef": {
      const sha = repo.store.getRef("refs/heads/" + repo.defaultBranch);
      if (!sha) return null;
      return {
        __type: "Ref",
        name: repo.defaultBranch,
        prefix: "refs/heads/",
        target: {
          __type: "Commit",
          oid: sha,
          message: repo.store.getCommit(sha)?.message ?? "",
          committedDate: repo.updatedAt,
        },
        repository: repo,
      };
    }
    case "viewerPermission":
      return "ADMIN";
    case "hasIssuesEnabled":
      return true;
    case "issue": {
      const n = Number(args("number"));
      const issue = repo.issues.get(n);
      return issue ? issueObj(issue) : null;
    }
    case "issues": {
      let list = Array.from(repo.issues.values());
      const filter = args("filterBy") || {};
      let states = filter.states;
      if (!states) states = args("states");
      if (Array.isArray(states) && states.length > 0) {
        const wanted = states.map((s: any) => String(s).toUpperCase());
        list = list.filter((i) => wanted.includes(i.state.toUpperCase()));
      }
      list = sortIssues(list, args("orderBy"));
      const total = list.length;
      const first = args("first");
      const after = args("after");
      // Cursor pagination: `after` is the endCursor of the previous page, which we encode as the
      // index of the last item it held. Everything after that index is the next page.
      if (after !== undefined && after !== null && after !== "") {
        const idx = Number(after);
        if (Number.isFinite(idx)) list = list.slice(idx + 1);
      }
      const pageStart = list.length;
      if (first !== undefined && first !== null) list = list.slice(0, Number(first));
      return connection(list.map(issueObj), total, list.length < pageStart);
    }
    case "pullRequests": {
      let list = Array.from(repo.pulls.values());
      const states = args("states");
      if (Array.isArray(states) && states.length > 0) {
        const wanted = states.map((s: any) => String(s).toUpperCase());
        list = list.filter((p) => wanted.includes(p.state.toUpperCase()));
      }
      list.sort((a, b) => b.number - a.number);
      const total = list.length;
      const first = args("first");
      if (first !== undefined && first !== null) list = list.slice(0, Number(first));
      return connection(list.map(pullObj), total);
    }
    case "pullRequest": {
      const n = Number(args("number"));
      const pull = repo.pulls.get(n);
      return pull ? pullObj(pull) : null;
    }
    case "description":
      return repo.description;
    case "isPrivate":
      return repo.private;
    case "isFork":
    case "isArchived":
      return false;
    case "createdAt":
      return repo.createdAt;
    case "updatedAt":
      return repo.updatedAt;
    case "url":
      return "https://github.com/" + repo.owner + "/" + repo.name;
    case "ref": {
      const name = String(args("qualifiedName") ?? "");
      const sha = repo.store.getRef(name);
      if (!sha) return null;
      return {
        __type: "Ref",
        name: name.replace(/^refs\/heads\//, ""),
        prefix: name.startsWith("refs/tags/") ? "refs/tags/" : "refs/heads/",
        target: { __type: "Commit", oid: sha, message: repo.store.getCommit(sha)?.message ?? "" },
        repository: repo,
      };
    }
    case "object":
    case "commit": {
      const expr = String(args("expression") ?? "HEAD");
      if (expr === "HEAD") {
        const sha = repo.store.headSha();
        return sha ? { __type: "Commit", oid: sha, message: repo.store.getCommit(sha)?.message ?? "" } : null;
      }
      if (repo.store.hasObject(expr)) {
        const o = repo.store.getObject(expr);
        if (o?.type === "commit") return { __type: "Commit", oid: expr, message: repo.store.getCommit(expr)?.message ?? "" };
        if (o?.type === "blob") return { __type: "Blob", oid: expr, text: o.body.toString("utf8"), isBinary: false };
      }
      return null;
    }
    case "branches": {
      const refs = Array.from(repo.store.refs.entries())
        .filter(([n]) => n.startsWith("refs/heads/"))
        .map(([n, sha]) => ({
          __type: "Ref",
          name: n.slice("refs/heads/".length),
          prefix: "refs/heads/",
          target: { __type: "Commit", oid: sha, message: repo.store.getCommit(sha)?.message ?? "" },
          repository: repo,
        }));
      return connection(refs, refs.length);
    }
    default:
      return null;
  }
}

function resolveIssue(fld: GqlField, obj: any, env: Env): any {
  const issue: Issue = obj.data;
  const repo = issue.repo;
  switch (fld.name) {
    case "id":
      return globalId("I", issue.id);
    case "number":
      return issue.number;
    case "title":
      return issue.title;
    case "state":
      return issue.state.toUpperCase();
    case "body":
      return issue.body;
    case "createdAt":
      return issue.createdAt;
    case "updatedAt":
      return issue.updatedAt;
    case "closed":
      return issue.state === "closed";
    case "closedAt":
      return issue.state === "closed" ? issue.updatedAt : null;
    case "author":
    case "user":
      return userObj(env.forge.ensureUser(issue.user));
    case "labels":
      return connection(issue.labels.map(labelObj), issue.labels.length);
    case "url":
      return "https://github.com/" + repo.owner + "/" + repo.name + "/issues/" + issue.number;
    case "repository":
      return repoObj(repo);
    case "comments":
      return connection([], 0);
    case "isPinned":
      return false;
    default:
      return null;
  }
}

function resolvePull(fld: GqlField, obj: any, env: Env): any {
  const pull: Pull = obj.data;
  const repo = pull.repo;
  switch (fld.name) {
    case "id":
      return globalId("PR", pull.id);
    case "number":
      return pull.number;
    case "title":
      return pull.title;
    case "state":
      return pull.state.toUpperCase();
    case "body":
      return pull.body;
    case "merged":
      return pull.merged;
    case "mergeable":
      return pull.merged ? "UNKNOWN" : pullMergeable(repo, pull) ? "MERGEABLE" : "CONFLICTING";
    case "mergedAt":
      return pull.mergedAt;
    case "createdAt":
      return pull.createdAt;
    case "updatedAt":
      return pull.updatedAt;
    case "headRefName":
      return pull.headRef;
    case "baseRefName":
      return pull.baseRef;
    case "headRefOid":
      return repo.store.getRef("refs/heads/" + pull.headRef) ?? null;
    case "baseRefOid":
      return repo.store.getRef("refs/heads/" + pull.baseRef) ?? null;
    case "headRepository":
    case "baseRepository":
    case "repository":
      return repoObj(repo);
    case "files":
      return connection(pullFiles(pull), pullFiles(pull).length);
    case "commits":
      return connection([], 0);
    case "author":
      return userObj(env.forge.ensureUser(pull.user));
    case "mergedBy":
      return pull.merged ? userObj(env.forge.ensureUser(pull.user)) : null;
    case "mergeCommit":
      return pull.mergeCommitSha
        ? { __type: "Commit", oid: pull.mergeCommitSha, message: "" }
        : null;
    case "isDraft":
      return false;
    case "additions":
    case "deletions":
      return 0;
    case "changedFiles":
      return pullFiles(pull).length;
    case "url":
      return "https://github.com/" + repo.owner + "/" + repo.name + "/pull/" + pull.number;
    default:
      return null;
  }
}

function resolveField(typeName: string, fld: GqlField, obj: any, env: Env): any {
  if (fld.name === "__typename") return typeName;
  switch (typeName) {
    case "Node":
    case "GitObject":
      // A Node-typed value is really a Repository/Issue/PullRequest/... object; resolve its id
      // through the concrete type so node(id:) { id } round-trips the same global id.
      if (fld.name === "id") {
        const concrete = obj?.__type;
        if (concrete === "Repository") return globalId("R", obj.data.id);
        if (concrete === "Issue") return globalId("I", obj.data.id);
        if (concrete === "PullRequest") return globalId("PR", obj.data.id);
        if (concrete === "IssueComment") return globalId("C", obj.data.id);
      }
      return obj?.[fld.name] ?? null;
    case "Query":
      return resolveQuery(fld, env);
    case "Mutation":
      return resolveMutation(fld, env);
    case "Repository":
      return resolveRepository(fld, obj, env);
    case "Issue":
      return resolveIssue(fld, obj, env);
    case "PullRequest":
      return resolvePull(fld, obj, env);
    case "User": {
      const u: User = obj.data;
      if (fld.name === "id") return globalId("U", u.id);
      if (fld.name === "databaseId") return u.id;
      if (fld.name === "login") return u.login;
      if (fld.name === "name") return u.name;
      if (fld.name === "email") return u.email;
      if (fld.name === "url") return "https://github.com/" + u.login;
      if (fld.name === "avatarUrl") return "https://avatars.githubusercontent.com/u/" + u.id + "?v=4";
      return null;
    }
    case "Label": {
      const l: Label = obj.data;
      if (fld.name === "id") return globalId("L", l.id);
      if (fld.name === "name") return l.name;
      if (fld.name === "color") return l.color;
      if (fld.name === "description") return l.description;
      return null;
    }
    case "Ref":
      if (fld.name === "name" || fld.name === "prefix" || fld.name === "target" || fld.name === "repository") {
        if (fld.name === "repository") return repoObj(obj.repository);
        return obj[fld.name];
      }
      return null;
    case "Commit":
      if (fld.name === "id") return globalId("C", 0);
      if (fld.name === "oid") return obj.oid;
      if (fld.name === "abbreviatedOid") return String(obj.oid).slice(0, 7);
      if (fld.name === "message" || fld.name === "messageHeadline") return obj.message ?? "";
      if (fld.name === "committedDate") return obj.committedDate ?? null;
      if (fld.name === "author" || fld.name === "committer") {
        return { __type: "GitActor", name: "", email: "", user: null };
      }
      if (fld.name === "tree") return { __type: "Tree", oid: "", entries: [] };
      if (fld.name === "parents") return connection([], 0);
      if (fld.name === "url") return "";
      return null;
    case "GitActor":
      if (fld.name === "name") return obj.name ?? "";
      if (fld.name === "email") return obj.email ?? "";
      if (fld.name === "user") return obj.user ?? null;
      return null;
    case "Tree":
      if (fld.name === "oid") return obj.oid ?? "";
      if (fld.name === "entries") return obj.entries ?? [];
      return null;
    case "TreeEntry":
      return obj[fld.name] ?? null;
    case "Blob":
      if (fld.name === "oid") return obj.oid ?? "";
      if (fld.name === "text") return obj.text ?? "";
      if (fld.name === "isBinary") return !!obj.isBinary;
      return null;
    case "PageInfo":
      return obj[fld.name] ?? null;
    case "IssueConnection":
      return connectionField(fld.name, obj, env, "Issue");
    case "PullRequestConnection":
      return connectionField(fld.name, obj, env, "PullRequest");
    case "LabelConnection":
      return connectionField(fld.name, obj, env, "Label");
    case "CommentConnection":
      return connectionField(fld.name, obj, env, "IssueComment");
    case "CommitConnection":
      return connectionField(fld.name, obj, env, "Commit");
    case "PullRequestChangedFileConnection":
      return connectionField(fld.name, obj, env, "PullRequestChangedFile");
    case "RefConnection":
      return connectionField(fld.name, obj, env, "Ref");
    case "SearchResultItemConnection": {
      if (fld.name === "nodes") return obj.items;
      if (fld.name === "totalCount") return obj.totalCount;
      if (fld.name === "issueCount") return obj.issueCount ?? 0;
      if (fld.name === "pageInfo") return obj.pageInfo;
      if (fld.name === "edges") return (obj.items ?? []).map((n: any, i: number) => ({ __type: "SearchResultItemEdge", node: n, cursor: String(i) }));
      return null;
    }
    case "IssueEdge":
    case "PullRequestEdge":
    case "LabelEdge":
    case "IssueCommentEdge":
    case "CommitEdge":
    case "PullRequestChangedFileEdge":
    case "RefEdge":
    case "SearchResultItemEdge":
      return obj[fld.name] ?? null;
    case "PullRequestChangedFile":
      return obj[fld.name] ?? null;
    case "IssueComment":
      if (fld.name === "id") return globalId("C", obj.data.id);
      if (fld.name === "body") return obj.data.body;
      if (fld.name === "author") {
        const u = env.forge.getUser(obj.data.user);
        return u ? userObj(u) : null;
      }
      return null;
    case "CreatePullRequestPayload":
    case "CreateIssuePayload":
    case "MergePullRequestPayload":
    case "CloseIssuePayload":
    case "AddCommentPayload":
      if (fld.name === "pullRequest" && obj.pullRequest) return obj.pullRequest;
      if (fld.name === "issue" && obj.issue) return obj.issue;
      if (fld.name === "commentEdge" && obj.commentEdge) return obj.commentEdge;
      return obj[fld.name] ?? null;
    case "CommentEdge":
      return obj[fld.name] ?? null;
    case "__Schema":
      return obj[fld.name] ?? null;
    case "__Type":
      return obj[fld.name] ?? null;
    case "__Field":
      return obj[fld.name] ?? null;
    case "__InputValue":
      return obj[fld.name] ?? null;
    case "__EnumValue":
      return obj[fld.name] ?? null;
    case "__Directive":
      return obj[fld.name] ?? null;
    default:
      return null;
  }
}

function connectionField(name: string, obj: any, env: Env, itemType: string): any {
  if (name === "nodes") return obj.items;
  if (name === "totalCount") return obj.totalCount;
  if (name === "pageInfo") return obj.pageInfo;
  if (name === "edges") {
    return (obj.items ?? []).map((n: any, i: number) => ({
      __type: itemType + "Edge",
      node: n,
      cursor: String(i),
    }));
  }
  return null;
}

function typeMatches(wanted: string | undefined, actual: string): boolean {
  if (!wanted) return true;
  if (wanted === actual) return true;
  const def = TYPES[wanted];
  if (def?.kind === "UNION" || def?.kind === "INTERFACE") return true;
  return false;
}

function execSelectionSet(typeName: string, obj: any, selections: GqlSelection[], env: Env): any {
  if (obj === null || obj === undefined) return null;
  const out: Record<string, any> = {};
  for (const sel of selections) {
    if (sel.kind === "spread") {
      const fragment = env.fragments.get(sel.name);
      if (fragment && typeMatches(fragment.typeName, typeName)) {
        Object.assign(out, execSelectionSet(typeName, obj, fragment.selections, env));
      }
      continue;
    }
    if (sel.kind === "inline") {
      if (typeMatches(sel.typeName, typeName)) {
        Object.assign(out, execSelectionSet(typeName, obj, sel.selections, env));
      }
      continue;
    }
    const fld = sel.field;
    const key = fld.alias || fld.name;
    if (fld.name === "__typename") {
      out[key] = typeName;
      continue;
    }
    const def = TYPES[typeName];
    let fd = def?.fields?.find((f) => f.name === fld.name);
    if (!fd && fld.name === "__typename") fd = field("__typename", "String");
    if (!fd) {
      env.errors.push({ message: 'Cannot query field "' + fld.name + '" on type "' + typeName + '".' });
      continue;
    }
    const value = resolveField(typeName, fld, obj, env);
    if (fld.selections && fld.selections.length > 0) {
      if (value === null || value === undefined) out[key] = null;
      else if (Array.isArray(value)) out[key] = value.map((v) => execSelectionSet(fd.typeName, v, fld.selections!, env));
      else {
        // A field typed as an interface (Node) holds a concrete object: run the selection set
        // against the concrete type so `... on Repository` applies and id round-trips.
        const concrete = value && value.__type && value.__type !== typeName && TYPES[value.__type] ? value.__type : fd.typeName;
        out[key] = execSelectionSet(concrete, value, fld.selections, env);
      }
    } else {
      out[key] = value === undefined ? null : value;
    }
  }
  return out;
}

function executeDocument(doc: GqlDocument, variables: Record<string, any>, forge: Forge, login: string, operationName?: string): any {
  let operations = doc.operations;
  if (operationName) operations = operations.filter((o) => o.name === operationName);
  const env: Env = {
    forge,
    login,
    vars: variables && typeof variables === "object" ? variables : {},
    fragments: doc.fragments,
    errors: [],
  };
  const data: Record<string, any> = {};
  if (operations.length === 0) {
    return { data: null, errors: [{ message: "No operation found" }] };
  }
  for (const op of operations) {
    const typeName = op.operation === "mutation" ? "Mutation" : "Query";
    const result = execSelectionSet(typeName, { __type: typeName }, op.selections, env) ?? {};
    Object.assign(data, result);
  }
  if (env.errors.length > 0) return { data, errors: env.errors };
  return { data };
}

function runOne(body: any, forge: Forge, login: string): any {
  const query = body && typeof body.query === "string" ? body.query : "";
  if (!query) return { errors: [{ message: "Must provide query string." }] };
  try {
    const doc = new Parser(query).parseDocument();
    if (doc.operations.length > 1 && !body.operationName) {
      return doc.operations.map((op) => {
        const one: GqlDocument = { operations: [op], fragments: doc.fragments };
        return executeDocument(one, body.variables, forge, login);
      });
    }
    return executeDocument(doc, body.variables, forge, login, body.operationName);
  } catch (err: any) {
    return { errors: [{ message: err && err.message ? String(err.message) : "Parse error" }] };
  }
}

export async function handleGraphql(ctx: Ctx): Promise<void> {
  if (!authorized(ctx)) {
    sendError(ctx, 401, "Requires authentication");
    return;
  }
  const text = ctx.body.length ? ctx.body.toString("utf8") : "";
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendError(ctx, 400, "Problems parsing JSON");
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(ctx, 200, parsed.map((entry) => runOne(entry, ctx.forge, ctx.login)));
    return;
  }
  sendJson(ctx, 200, runOne(parsed, ctx.forge, ctx.login));
}
