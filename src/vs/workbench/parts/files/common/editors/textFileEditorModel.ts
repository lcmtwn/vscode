/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import nls = require('vs/nls');
import Event, {Emitter} from 'vs/base/common/event';
import {TPromise} from 'vs/base/common/winjs.base';
import {onUnexpectedError} from 'vs/base/common/errors';
import {toErrorMessage} from 'vs/base/common/errorMessage';
import URI from 'vs/base/common/uri';
import {IDisposable} from 'vs/base/common/lifecycle';
import paths = require('vs/base/common/paths');
import diagnostics = require('vs/base/common/diagnostics');
import types = require('vs/base/common/types');
import {IModelContentChangedEvent} from 'vs/editor/common/editorCommon';
import {IMode} from 'vs/editor/common/modes';
import {ITextFileService, IAutoSaveConfiguration, ModelState, ITextFileEditorModel, ISaveErrorHandler, ISaveParticipant, StateChange} from 'vs/workbench/parts/files/common/files';
import {EncodingMode, EditorModel} from 'vs/workbench/common/editor';
import {BaseTextEditorModel} from 'vs/workbench/common/editor/textEditorModel';
import {IFileService, IFileStat, IFileOperationResult, FileOperationResult} from 'vs/platform/files/common/files';
import {IInstantiationService} from 'vs/platform/instantiation/common/instantiation';
import {IMessageService, Severity} from 'vs/platform/message/common/message';
import {IModeService} from 'vs/editor/common/services/modeService';
import {IModelService} from 'vs/editor/common/services/modelService';
import {ITelemetryService, anonymize} from 'vs/platform/telemetry/common/telemetry';

/**
 * The text file editor model listens to changes to its underlying code editor model and saves these changes through the file service back to the disk.
 */
export class TextFileEditorModel extends BaseTextEditorModel implements ITextFileEditorModel {

	public static ID = 'workbench.editors.files.textFileEditorModel';

	private static saveErrorHandler: ISaveErrorHandler;
	private static saveParticipant: ISaveParticipant;

	private resource: URI;
	private contentEncoding: string; 			// encoding as reported from disk
	private preferredEncoding: string;			// encoding as chosen by the user
	private textModelChangeListener: IDisposable;
	private textFileServiceListener: IDisposable;
	private dirty: boolean;
	private versionId: number;
	private bufferSavedVersionId: number;
	private versionOnDiskStat: IFileStat;
	private blockModelContentChange: boolean;
	private autoSaveAfterMillies: number;
	private autoSaveAfterMilliesEnabled: boolean;
	private autoSavePromises: TPromise<void>[];
	private mapPendingSaveToVersionId: { [versionId: string]: TPromise<void> };
	private disposed: boolean;
	private inConflictResolutionMode: boolean;
	private inErrorMode: boolean;
	private lastSaveAttemptTime: number;
	private createTextEditorModelPromise: TPromise<TextFileEditorModel>;
	private _onDidStateChange: Emitter<StateChange>;

	constructor(
		resource: URI,
		preferredEncoding: string,
		@IMessageService private messageService: IMessageService,
		@IModeService modeService: IModeService,
		@IModelService modelService: IModelService,
		@IFileService private fileService: IFileService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@ITextFileService private textFileService: ITextFileService
	) {
		super(modelService, modeService);

		this.resource = resource;
		if (this.resource.scheme !== 'file') {
			throw new Error('TextFileEditorModel can only handle file:// resources.');
		}

		this._onDidStateChange = new Emitter<StateChange>();
		this.preferredEncoding = preferredEncoding;
		this.textModelChangeListener = null;
		this.dirty = false;
		this.autoSavePromises = [];
		this.versionId = 0;
		this.lastSaveAttemptTime = 0;
		this.mapPendingSaveToVersionId = {};

		this.updateAutoSaveConfiguration(textFileService.getAutoSaveConfiguration());
		this.registerListeners();
	}

	private registerListeners(): void {
		this.textFileServiceListener = this.textFileService.onAutoSaveConfigurationChange(config => this.updateAutoSaveConfiguration(config));
	}

	private updateAutoSaveConfiguration(config: IAutoSaveConfiguration): void {
		if (typeof config.autoSaveDelay === 'number' && config.autoSaveDelay > 0) {
			this.autoSaveAfterMillies = config.autoSaveDelay;
			this.autoSaveAfterMilliesEnabled = true;
		} else {
			this.autoSaveAfterMillies = void 0;
			this.autoSaveAfterMilliesEnabled = false;
		}
	}

	public get onDidStateChange(): Event<StateChange> {
		return this._onDidStateChange.event;
	}

	/**
	 * Set a save error handler to install code that executes when save errors occur.
	 */
	public static setSaveErrorHandler(handler: ISaveErrorHandler): void {
		TextFileEditorModel.saveErrorHandler = handler;
	}

	/**
	 * Set a save participant handler to react on models getting saved.
	 */
	public static setSaveParticipant(handler: ISaveParticipant): void {
		TextFileEditorModel.saveParticipant = handler;
	}

	/**
	 * When set, will disable any saving (including auto save) until the model is loaded again. This allows to resolve save conflicts
	 * without running into subsequent save errors when editing the model.
	 */
	public setConflictResolutionMode(): void {
		diag('setConflictResolutionMode() - enabled conflict resolution mode', this.resource, new Date());

		this.inConflictResolutionMode = true;
	}

	/**
	 * Answers if this model is currently in conflic resolution mode or not.
	 */
	public isInConflictResolutionMode(): boolean {
		return this.inConflictResolutionMode;
	}

	/**
	 * Discards any local changes and replaces the model with the contents of the version on disk.
	 */
	public revert(): TPromise<void> {
		if (!this.isResolved()) {
			return TPromise.as<void>(null);
		}

		// Cancel any running auto-saves
		this.cancelAutoSavePromises();

		// Unset flags
		const undo = this.setDirty(false);

		// Reload
		return this.load(true /* force */).then(() => {

			// Emit file change event
			this._onDidStateChange.fire(StateChange.REVERTED);
		}, (error) => {

			// FileNotFound means the file got deleted meanwhile, so emit revert event because thats ok
			if ((<IFileOperationResult>error).fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				this._onDidStateChange.fire(StateChange.REVERTED);
			}

			// Set flags back to previous values, we are still dirty if revert failed and we where
			else {
				undo();
			}

			return TPromise.wrapError(error);
		});
	}

	public load(force?: boolean /* bypass any caches and really go to disk */): TPromise<EditorModel> {
		diag('load() - enter', this.resource, new Date());

		// It is very important to not reload the model when the model is dirty. We only want to reload the model from the disk
		// if no save is pending to avoid data loss. This might cause a save conflict in case the file has been modified on the disk
		// meanwhile, but this is a very low risk.
		if (this.dirty) {
			diag('load() - exit - without loading because model is dirty', this.resource, new Date());

			return TPromise.as(this);
		}

		// Decide on etag
		let etag: string;
		if (force) {
			etag = undefined; // bypass cache if force loading is true
		} else if (this.versionOnDiskStat) {
			etag = this.versionOnDiskStat.etag; // otherwise respect etag to support caching
		}

		// Resolve Content
		return this.textFileService.resolveTextContent(this.resource, { acceptTextOnly: true, etag: etag, encoding: this.preferredEncoding }).then((content) => {
			diag('load() - resolved content', this.resource, new Date());

			// Telemetry
			this.telemetryService.publicLog('fileGet', { mimeType: content.mime, ext: paths.extname(this.resource.fsPath), path: anonymize(this.resource.fsPath) });

			// Update our resolved disk stat model
			const resolvedStat: IFileStat = {
				resource: this.resource,
				name: content.name,
				mtime: content.mtime,
				etag: content.etag,
				mime: content.mime,
				isDirectory: false,
				hasChildren: false,
				children: void 0,
			};
			this.updateVersionOnDiskStat(resolvedStat);

			// Keep the original encoding to not loose it when saving
			const oldEncoding = this.contentEncoding;
			this.contentEncoding = content.encoding;

			// Handle events if encoding changed
			if (this.preferredEncoding) {
				this.updatePreferredEncoding(this.contentEncoding); // make sure to reflect the real encoding of the file (never out of sync)
			} else if (oldEncoding !== this.contentEncoding) {
				this._onDidStateChange.fire(StateChange.ENCODING);
			}

			// Update Existing Model
			if (this.textEditorModel) {
				diag('load() - updated text editor model', this.resource, new Date());

				this.setDirty(false); // Ensure we are not tracking a stale state

				this.blockModelContentChange = true;
				try {
					this.updateTextEditorModel(content.value);
				} finally {
					this.blockModelContentChange = false;
				}

				return TPromise.as<EditorModel>(this);
			}

			// Join an existing request to create the editor model to avoid race conditions
			else if (this.createTextEditorModelPromise) {
				diag('load() - join existing text editor model promise', this.resource, new Date());

				return this.createTextEditorModelPromise;
			}

			// Create New Model
			else {
				diag('load() - created text editor model', this.resource, new Date());

				this.createTextEditorModelPromise = this.createTextEditorModel(content.value, content.resource).then(() => {
					this.createTextEditorModelPromise = null;

					this.setDirty(false); // Ensure we are not tracking a stale state
					this.textModelChangeListener = this.textEditorModel.onDidChangeRawContent((e: IModelContentChangedEvent) => this.onModelContentChanged(e));

					return this;
				}, (error) => {
					this.createTextEditorModelPromise = null;

					return TPromise.wrapError(error);
				});

				return this.createTextEditorModelPromise;
			}
		}, (error) => {

			// NotModified status code is expected and can be handled gracefully
			if ((<IFileOperationResult>error).fileOperationResult === FileOperationResult.FILE_NOT_MODIFIED_SINCE) {
				this.setDirty(false); // Ensure we are not tracking a stale state

				return TPromise.as<EditorModel>(this);
			}

			// Otherwise bubble up the error
			return TPromise.wrapError(error);
		});
	}

	protected getOrCreateMode(modeService: IModeService, preferredModeIds: string, firstLineText?: string): TPromise<IMode> {
		return modeService.getOrCreateModeByFilenameOrFirstLine(this.resource.fsPath, firstLineText);
	}

	private onModelContentChanged(e: IModelContentChangedEvent): void {
		diag('onModelContentChanged(' + e.changeType + ') - enter', this.resource, new Date());

		// In any case increment the version id because it tracks the textual content state of the model at all times
		this.versionId++;
		diag('onModelContentChanged() - new versionId ' + this.versionId, this.resource, new Date());

		// Ignore if blocking model changes
		if (this.blockModelContentChange) {
			return;
		}

		// The contents changed as a matter of Undo and the version reached matches the saved one
		// In this case we clear the dirty flag and emit a SAVED event to indicate this state.
		// Note: we currently only do this check when auto-save is turned off because there you see
		// a dirty indicator that you want to get rid of when undoing to the saved version.
		if (!this.autoSaveAfterMilliesEnabled && this.textEditorModel.getAlternativeVersionId() === this.bufferSavedVersionId) {
			diag('onModelContentChanged() - model content changed back to last saved version', this.resource, new Date());

			// Clear flags
			const wasDirty = this.dirty;
			this.setDirty(false);

			// Emit event
			if (wasDirty) {
				this._onDidStateChange.fire(StateChange.REVERTED);
			}

			return;
		}

		diag('onModelContentChanged() - model content changed and marked as dirty', this.resource, new Date());

		// Mark as dirty
		this.makeDirty(e);

		// Start auto save process unless we are in conflict resolution mode and unless it is disabled
		if (this.autoSaveAfterMilliesEnabled) {
			if (!this.inConflictResolutionMode) {
				this.doAutoSave(this.versionId);
			} else {
				diag('makeDirty() - prevented save because we are in conflict resolution mode', this.resource, new Date());
			}
		}
	}

	private makeDirty(e?: IModelContentChangedEvent): void {

		// Track dirty state and version id
		const wasDirty = this.dirty;
		this.setDirty(true);

		// Emit as Event if we turned dirty
		if (!wasDirty) {
			this._onDidStateChange.fire(StateChange.DIRTY);
		}
	}

	private doAutoSave(versionId: number): TPromise<void> {
		diag('doAutoSave() - enter for versionId ' + versionId, this.resource, new Date());

		// Cancel any currently running auto saves to make this the one that succeeds
		this.cancelAutoSavePromises();

		// Create new save promise and keep it
		const promise: TPromise<void> = TPromise.timeout(this.autoSaveAfterMillies).then(() => {

			// Only trigger save if the version id has not changed meanwhile
			if (versionId === this.versionId) {
				this.doSave(versionId, true); // Very important here to not return the promise because if the timeout promise is canceled it will bubble up the error otherwise - do not change
			}
		});

		this.autoSavePromises.push(promise);

		return promise;
	}

	private cancelAutoSavePromises(): void {
		while (this.autoSavePromises.length) {
			this.autoSavePromises.pop().cancel();
		}
	}

	/**
	 * Saves the current versionId of this editor model if it is dirty.
	 */
	public save(overwriteReadonly?: boolean, overwriteEncoding?: boolean): TPromise<void> {
		if (!this.isResolved()) {
			return TPromise.as<void>(null);
		}

		diag('save() - enter', this.resource, new Date());

		// Cancel any currently running auto saves to make this the one that succeeds
		this.cancelAutoSavePromises();

		return this.doSave(this.versionId, false, overwriteReadonly, overwriteEncoding);
	}

	private doSave(versionId: number, isAutoSaved: boolean, overwriteReadonly?: boolean, overwriteEncoding?: boolean): TPromise<void> {
		diag('doSave(' + versionId + ') - enter with versionId ' + versionId, this.resource, new Date());

		// Lookup any running pending save for this versionId and return it if found
		const pendingSave = this.mapPendingSaveToVersionId[versionId];
		if (pendingSave) {
			diag('doSave(' + versionId + ') - exit - found a pending save for versionId ' + versionId, this.resource, new Date());

			return pendingSave;
		}

		// Return early if not dirty or version changed meanwhile
		if (!this.dirty || versionId !== this.versionId) {
			diag('doSave(' + versionId + ') - exit - because not dirty and/or versionId is different (this.isDirty: ' + this.dirty + ', this.versionId: ' + this.versionId + ')', this.resource, new Date());

			return TPromise.as<void>(null);
		}

		// Return if currently saving by scheduling another auto save. Never ever must 2 saves execute at the same time because
		// this can lead to dirty writes and race conditions
		if (this.isBusySaving()) {
			diag('doSave(' + versionId + ') - exit - because busy saving', this.resource, new Date());

			// Avoid endless loop here and guard if auto save is disabled
			if (this.autoSaveAfterMilliesEnabled) {
				return this.doAutoSave(versionId);
			}
		}

		// Push all edit operations to the undo stack so that the user has a chance to
		// Ctrl+Z back to the saved version. We only do this when auto-save is turned off
		if (!this.autoSaveAfterMilliesEnabled) {
			this.textEditorModel.pushStackElement();
		}

		// A save participant can still change the model now and since we are so close to saving
		// we do not want to trigger another auto save or similar, so we block this
		// In addition we update our version right after in case it changed because of a model change
		if (TextFileEditorModel.saveParticipant) {
			this.blockModelContentChange = true;
			try {
				TextFileEditorModel.saveParticipant.participate(this, { isAutoSaved });
			} finally {
				this.blockModelContentChange = false;
			}
			versionId = this.versionId;
		}

		// Clear error flag since we are trying to save again
		this.inErrorMode = false;

		// Remember when this model was saved last
		this.lastSaveAttemptTime = Date.now();

		// Save to Disk
		diag('doSave(' + versionId + ') - before updateContent()', this.resource, new Date());
		this.mapPendingSaveToVersionId[versionId] = this.fileService.updateContent(this.versionOnDiskStat.resource, this.getValue(), {
			overwriteReadonly: overwriteReadonly,
			overwriteEncoding: overwriteEncoding,
			mtime: this.versionOnDiskStat.mtime,
			encoding: this.getEncoding(),
			etag: this.versionOnDiskStat.etag
		}).then((stat: IFileStat) => {
			diag('doSave(' + versionId + ') - after updateContent()', this.resource, new Date());

			// Telemetry
			this.telemetryService.publicLog('filePUT', { mimeType: stat.mime, ext: paths.extname(this.versionOnDiskStat.resource.fsPath) });

			// Remove from pending saves
			delete this.mapPendingSaveToVersionId[versionId];

			// Update dirty state unless model has changed meanwhile
			if (versionId === this.versionId) {
				diag('doSave(' + versionId + ') - setting dirty to false because versionId did not change', this.resource, new Date());
				this.setDirty(false);
			} else {
				diag('doSave(' + versionId + ') - not setting dirty to false because versionId did change meanwhile', this.resource, new Date());
			}

			// Updated resolved stat with updated stat, and keep old for event
			this.updateVersionOnDiskStat(stat);

			// Emit File Saved Event
			this._onDidStateChange.fire(StateChange.SAVED);
		}, (error) => {
			diag('doSave(' + versionId + ') - exit - resulted in a save error: ' + error.toString(), this.resource, new Date());

			// Remove from pending saves
			delete this.mapPendingSaveToVersionId[versionId];

			// Flag as error state
			this.inErrorMode = true;

			// Show to user
			this.onSaveError(error);

			// Emit as event
			this._onDidStateChange.fire(StateChange.SAVE_ERROR);
		});

		return this.mapPendingSaveToVersionId[versionId];
	}

	private setDirty(dirty: boolean): () => void {
		const wasDirty = this.dirty;
		const wasInConflictResolutionMode = this.inConflictResolutionMode;
		const wasInErrorMode = this.inErrorMode;
		const oldBufferSavedVersionId = this.bufferSavedVersionId;

		if (!dirty) {
			this.dirty = false;
			this.inConflictResolutionMode = false;
			this.inErrorMode = false;

			// we remember the models alternate version id to remember when the version
			// of the model matches with the saved version on disk. we need to keep this
			// in order to find out if the model changed back to a saved version (e.g.
			// when undoing long enough to reach to a version that is saved and then to
			// clear the dirty flag)
			if (this.textEditorModel) {
				this.bufferSavedVersionId = this.textEditorModel.getAlternativeVersionId();
			}
		} else {
			this.dirty = true;
		}

		// Return function to revert this call
		return () => {
			this.dirty = wasDirty;
			this.inConflictResolutionMode = wasInConflictResolutionMode;
			this.inErrorMode = wasInErrorMode;
			this.bufferSavedVersionId = oldBufferSavedVersionId;
		};
	}

	private updateVersionOnDiskStat(newVersionOnDiskStat: IFileStat): void {

		// First resolve - just take
		if (!this.versionOnDiskStat) {
			this.versionOnDiskStat = newVersionOnDiskStat;
		}

		// Subsequent resolve - make sure that we only assign it if the mtime is equal or has advanced.
		// This is essential a If-Modified-Since check on the client ot prevent race conditions from loading
		// and saving. If a save comes in late after a revert was called, the mtime could be out of sync.
		else if (this.versionOnDiskStat.mtime <= newVersionOnDiskStat.mtime) {
			this.versionOnDiskStat = newVersionOnDiskStat;
		}
	}

	private onSaveError(error: any): void {

		// Prepare handler
		if (!TextFileEditorModel.saveErrorHandler) {
			TextFileEditorModel.setSaveErrorHandler(this.instantiationService.createInstance(DefaultSaveErrorHandler));
		}

		// Handle
		TextFileEditorModel.saveErrorHandler.onSaveError(error, this);
	}

	private isBusySaving(): boolean {
		return !types.isEmptyObject(this.mapPendingSaveToVersionId);
	}

	/**
	 * Returns true if the content of this model has changes that are not yet saved back to the disk.
	 */
	public isDirty(): boolean {
		return this.dirty;
	}

	/**
	 * Returns the time in millies when this working copy was attempted to be saved.
	 */
	public getLastSaveAttemptTime(): number {
		return this.lastSaveAttemptTime;
	}

	/**
	 * Returns the time in millies when this working copy was last modified by the user or some other program.
	 */
	public getLastModifiedTime(): number {
		return this.versionOnDiskStat ? this.versionOnDiskStat.mtime : -1;
	}

	/**
	 * Returns the state this text text file editor model is in with regards to changes and saving.
	 */
	public getState(): ModelState {
		if (this.inConflictResolutionMode) {
			return ModelState.CONFLICT;
		}

		if (this.inErrorMode) {
			return ModelState.ERROR;
		}

		if (!this.dirty) {
			return ModelState.SAVED;
		}

		if (this.isBusySaving()) {
			return ModelState.PENDING_SAVE;
		}

		if (this.dirty) {
			return ModelState.DIRTY;
		}
	}

	public getEncoding(): string {
		return this.preferredEncoding || this.contentEncoding;
	}

	public setEncoding(encoding: string, mode: EncodingMode): void {
		if (!this.isNewEncoding(encoding)) {
			return; // return early if the encoding is already the same
		}

		// Encode: Save with encoding
		if (mode === EncodingMode.Encode) {
			this.updatePreferredEncoding(encoding);

			// Save
			if (!this.isDirty()) {
				this.versionId++; // needs to increment because we change the model potentially
				this.makeDirty();
			}

			if (!this.inConflictResolutionMode) {
				this.save(false, true /* overwriteEncoding due to forced encoding change */).done(null, onUnexpectedError);
			}
		}

		// Decode: Load with encoding
		else {
			if (this.isDirty()) {
				this.messageService.show(Severity.Info, nls.localize('saveFileFirst', "The file is dirty. Please save it first before reopening it with another encoding."));

				return;
			}

			this.updatePreferredEncoding(encoding);

			// Load
			this.load(true /* force because encoding has changed */).done(null, onUnexpectedError);
		}
	}

	public updatePreferredEncoding(encoding: string): void {
		if (!this.isNewEncoding(encoding)) {
			return;
		}

		this.preferredEncoding = encoding;

		// Emit
		this._onDidStateChange.fire(StateChange.ENCODING);
	}

	private isNewEncoding(encoding: string): boolean {
		if (this.preferredEncoding === encoding) {
			return false; // return early if the encoding is already the same
		}

		if (!this.preferredEncoding && this.contentEncoding === encoding) {
			return false; // also return if we don't have a preferred encoding but the content encoding is already the same
		}

		return true;
	}

	public isResolved(): boolean {
		return !types.isUndefinedOrNull(this.versionOnDiskStat);
	}

	/**
	 * Returns true if the dispose() method of this model has been called.
	 */
	public isDisposed(): boolean {
		return this.disposed;
	}

	/**
	 * Returns the full resource URI of the file this text file editor model is about.
	 */
	public getResource(): URI {
		return this.resource;
	}

	public dispose(): void {
		this.disposed = true;
		this.inConflictResolutionMode = false;
		this.inErrorMode = false;

		this._onDidStateChange.dispose();

		this.createTextEditorModelPromise = null;

		if (this.textModelChangeListener) {
			this.textModelChangeListener.dispose();
			this.textModelChangeListener = null;
		}

		if (this.textFileServiceListener) {
			this.textFileServiceListener.dispose();
			this.textFileServiceListener = null;
		}

		this.cancelAutoSavePromises();

		super.dispose();
	}
}

class DefaultSaveErrorHandler implements ISaveErrorHandler {

	constructor(@IMessageService private messageService: IMessageService) { }

	public onSaveError(error: any, model: TextFileEditorModel): void {
		this.messageService.show(Severity.Error, nls.localize('genericSaveError', "Failed to save '{0}': {1}", paths.basename(model.getResource().fsPath), toErrorMessage(error, false)));
	}
}

// Diagnostics support
let diag: (...args: any[]) => void;
if (!diag) {
	diag = diagnostics.register('TextFileEditorModelDiagnostics', function (...args: any[]) {
		console.log(args[1] + ' - ' + args[0] + ' (time: ' + args[2].getTime() + ' [' + args[2].toUTCString() + '])');
	});
}