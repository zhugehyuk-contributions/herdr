/**
 * Node-only entry point: `@herdr/client-ts/node`.
 *
 * Split from `.` because `ssh2` is a Node package (native crypto bindings, `Buffer`, `stream`) and
 * the `.` entry has to load on Hermes. Nothing here is reachable from `src/index.ts`; see
 * `src/node/sshTransport.ts` for the guards that keep it that way.
 */
export {
  DEFAULT_SESSION_NAME,
  SshHerdrTransport,
  type SshHerdrTransportOptions,
} from "./sshTransport.js";
