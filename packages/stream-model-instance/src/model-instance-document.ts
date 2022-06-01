import jsonpatch from 'fast-json-patch'
import * as dagCbor from '@ipld/dag-cbor'
import type { Operation } from 'fast-json-patch'
import * as uint8arrays from 'uint8arrays'
import { randomBytes } from '@stablelib/random'
import {
  CreateOpts,
  LoadOpts,
  UpdateOpts,
  Stream,
  StreamConstructor,
  StreamStatic,
  SyncOptions,
  CeramicCommit,
  CommitHeader,
  GenesisCommit,
  RawCommit,
  CeramicApi,
  SignedCommitContainer,
  StreamMetadata,
  CeramicSigner,
  GenesisHeader,
} from '@ceramicnetwork/common'
import { CommitID, StreamID, StreamRef } from '@ceramicnetwork/streamid'

/**
 * Arguments used to generate the metadata for Model Instance Documents
 */
export interface ModelInstanceDocumentMetadataArgs {
  /**
   * The DID(s) that are allowed to author updates to this ModelInstanceDocument
   */
  controllers?: Array<string>
}

const DEFAULT_CREATE_OPTS = {
  anchor: true,
  publish: true,
  pin: true,
  sync: SyncOptions.PREFER_CACHE,
}
const DEFAULT_LOAD_OPTS = { sync: SyncOptions.PREFER_CACHE }
const DEFAULT_UPDATE_OPTS = { anchor: true, publish: true, throwOnInvalidCommit: true }

/**
 * Converts from metadata format into CommitHeader format to be put into a CeramicCommit
 * @param metadata
 * @param genesis - True if this is for a genesis header, false if it's for a signed commit header
 */
function headerFromMetadata(
  metadata: ModelInstanceDocumentMetadataArgs | StreamMetadata | undefined,
  genesis: boolean
): CommitHeader {

  const header: CommitHeader = {
    controllers: metadata?.controllers,
  }

  // Handle properties that can only be set on the genesis commit.
  if (genesis) {
    header.unique = uint8arrays.toString(randomBytes(12), 'base64')
  }

  // Delete undefined keys from header
  Object.keys(header).forEach((key) => header[key] === undefined && delete header[key])
  return header
}

async function _ensureAuthenticated(signer: CeramicSigner) {
  if (signer.did == null) {
    throw new Error('No DID provided')
  }
  if (!signer.did.authenticated) {
    await signer.did.authenticate()
    if (signer.loggerProvider) {
      signer.loggerProvider.getDiagnosticsLogger().imp(`Now authenticated as DID ${signer.did.id}`)
    }
  }
}

/**
 * Sign a ModelInstanceDocument commit with the currently authenticated DID.
 * @param signer - Object containing the DID to use to sign the commit
 * @param commit - Commit to be signed
 * @private
 */
async function _signDagJWS(
  signer: CeramicSigner,
  commit: CeramicCommit
): Promise<SignedCommitContainer> {
  await _ensureAuthenticated(signer)
  return signer.did.createDagJWS(commit)
}

async function throwReadOnlyError(): Promise<void> {
  throw new Error(
    'Historical stream commits cannot be modified. Load the stream without specifying a commit to make updates.'
  )
}

/**
 * ModelInstanceDocument stream implementation
 */
@StreamStatic<StreamConstructor<ModelInstanceDocument>>()
export class ModelInstanceDocument<T = Record<string, any>> extends Stream {
  static STREAM_TYPE_NAME = 'MID'
  static STREAM_TYPE_ID = 3

  private _isReadOnly = false

  get content(): T {
    return super.content
  }

  /**
   * Creates a Model Instance Document.
   * @param ceramic - Instance of CeramicAPI used to communicate with the Ceramic network
   * @param content - Genesis contents. If 'null', then no signature is required to make the genesis commit
   * @param metadata - Genesis metadata
   * @param opts - Additional options
   */
  static async create<T>(
    ceramic: CeramicApi,
    content: T | null | undefined,
    metadata?: ModelInstanceDocumentMetadataArgs,
    opts: CreateOpts = {}
  ): Promise<ModelInstanceDocument<T>> {
    opts = { ...DEFAULT_CREATE_OPTS, ...opts }
    if (opts.syncTimeoutSeconds == undefined) {
      // By default you don't want to wait to sync doc state from pubsub when creating a unique
      // document as there shouldn't be any existing state for this doc on the network.
      opts.syncTimeoutSeconds = 0
    }
    const signer: CeramicSigner = opts.asDID ? { did: opts.asDID } : ceramic
    const commit = await ModelInstanceDocument.makeGenesis(signer, content, metadata)
    return ceramic.createStreamFromGenesis<ModelInstanceDocument<T>>(
      ModelInstanceDocument.STREAM_TYPE_ID,
      commit,
      opts
    )
  }

  /**
   * Create Model Instance Document from genesis commit
   * @param ceramic - Instance of CeramicAPI used to communicate with the Ceramic network
   * @param genesisCommit - Genesis commit (first commit in document log)
   * @param opts - Additional options
   */
  static async createFromGenesis<T>(
    ceramic: CeramicApi,
    genesisCommit: GenesisCommit,
    opts: CreateOpts = {}
  ): Promise<ModelInstanceDocument<T>> {
    opts = { ...DEFAULT_CREATE_OPTS, ...opts }
    if (genesisCommit.header?.unique && opts.syncTimeoutSeconds == undefined) {
      // By default you don't want to wait to sync doc state from pubsub when creating a unique
      // document as there shouldn't be any existing state for this doc on the network.
      opts.syncTimeoutSeconds = 0
    }
    const commit = genesisCommit.data ? await _signDagJWS(ceramic, genesisCommit) : genesisCommit
    return ceramic.createStreamFromGenesis<ModelInstanceDocument<T>>(
      ModelInstanceDocument.STREAM_TYPE_ID,
      commit,
      opts
    )
  }

  /**
   * Loads a Model Instance Document from a given StreamID
   * @param ceramic - Instance of CeramicAPI used to communicate with the Ceramic network
   * @param streamId - StreamID to load.  Must correspond to a ModelInstanceDocument
   * @param opts - Additional options
   */
  static async load<T>(
    ceramic: CeramicApi,
    streamId: StreamID | CommitID | string,
    opts: LoadOpts = {}
  ): Promise<ModelInstanceDocument<T>> {
    opts = { ...DEFAULT_LOAD_OPTS, ...opts }
    const streamRef = StreamRef.from(streamId)
    if (streamRef.type != ModelInstanceDocument.STREAM_TYPE_ID) {
      throw new Error(
        `StreamID ${streamRef.toString()} does not refer to a '${
          ModelInstanceDocument.STREAM_TYPE_NAME
        }' stream, but to a ${streamRef.typeName}`
      )
    }

    return ceramic.loadStream<ModelInstanceDocument<T>>(streamRef, opts)
  }

  /**
   * Update an existing Model Instance Document.
   * @param content - New content to replace old content
   * @param metadata - Changes to make to the metadata.  Only fields that are specified will be changed.
   * @param opts - Additional options
   */
  async update(
    content: T | null | undefined,
    metadata?: ModelInstanceDocumentMetadataArgs,
    opts: UpdateOpts = {}
  ): Promise<void> {
    opts = { ...DEFAULT_UPDATE_OPTS, ...opts }
    const signer: CeramicSigner = opts.asDID ? { did: opts.asDID } : this.api
    const updateCommit = await this.makeCommit(signer, content, metadata)
    const updated = await this.api.applyCommit(this.id, updateCommit, opts)
    this.state$.next(updated.state)
  }

  /**
   * Update the contents of an existing Model Instance Document based on a JSON-patch diff from the existing
   * contents to the desired new contents
   * @param jsonPatch - JSON patch diff of document contents
   * @param opts - Additional options
   */
  async patch(jsonPatch: Operation[], opts: UpdateOpts = {}): Promise<void> {
    opts = { ...DEFAULT_UPDATE_OPTS, ...opts }
    const header = headerFromMetadata(this.metadata, false)
    const rawCommit: RawCommit = {
      header,
      data: jsonPatch,
      prev: this.tip,
      id: this.state$.id.cid,
    }
    const commit = await _signDagJWS(this.api, rawCommit)
    const updated = await this.api.applyCommit(this.id, commit, opts)
    this.state$.next(updated.state)
  }

  /**
   * Makes this document read-only. After this has been called any future attempts to call
   * mutation methods on the instance will throw.
   */
  makeReadOnly() {
    this.update = throwReadOnlyError
    this.patch = throwReadOnlyError
    this.sync = throwReadOnlyError
    this._isReadOnly = true
  }

  get isReadOnly(): boolean {
    return this._isReadOnly
  }

  /**
   * Make a commit to update the document
   * @param signer - Object containing the DID making (and signing) the commit
   * @param newContent
   * @param newMetadata
   */
  async makeCommit(
    signer: CeramicSigner,
    newContent: T | null | undefined,
    newMetadata?: ModelInstanceDocumentMetadataArgs
  ): Promise<CeramicCommit> {
    const header = headerFromMetadata(newMetadata, false)

    if (newContent == null) {
      newContent = this.content
    }

    if (header.controllers && header.controllers?.length !== 1) {
      throw new Error('Exactly one controller must be specified')
    }

    const patch = jsonpatch.compare(this.content, newContent)
    const commit: RawCommit = {
      header,
      data: patch,
      prev: this.tip,
      id: this.state.log[0].cid,
    }
    return _signDagJWS(signer, commit)
  }

  /**
   * Create genesis commit.
   * @param signer - Object containing the DID making (and signing) the commit
   * @param content - genesis content
   * @param metadata - genesis metadata
   */
  static async makeGenesis<T>(
    signer: CeramicSigner,
    content: T | null | undefined,
    metadata?: ModelInstanceDocumentMetadataArgs
  ): Promise<CeramicCommit> {
    if (!metadata) {
      metadata = {}
    }

    if (!metadata.controllers || metadata.controllers.length === 0) {
      if (signer.did) {
        await _ensureAuthenticated(signer)
        // When did has parent, it has a capability, the did issuer (parent) of the capability is the stream controller
        metadata.controllers = [signer.did.hasParent ? signer.did.parent : signer.did.id]
      } else {
        throw new Error('No controllers specified')
      }
    }
    if (metadata.controllers?.length !== 1) {
      throw new Error('Exactly one controller must be specified')
    }

    const header: GenesisHeader = headerFromMetadata(metadata, true)

    if (content == null) {
      const result = { header }
      // Check if we can encode it in cbor. Should throw an error when invalid payload.
      dagCbor.encode(result)
      // No signature needed if no genesis content
      return result
    }
    const commit: GenesisCommit = { data: content, header }
    return _signDagJWS(signer, commit)
  }
}