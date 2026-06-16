import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import {
	IMAGE_METADATA_SCHEMA_VERSION,
	addImageMetadataSidecarSource,
	copyImageMetadataSidecar,
	findReusableImageMetadataSidecar,
	hasCurrentImageMetadataSidecar,
	imageMimeType,
	localizedImageInfo,
	writeImageMetadataSidecar,
} from '../utils/imageMetadata';

export class ImageMetadataExtractWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		if (!plugin.settings.imageMetadataExtractionEnabled) {
			return { status: 'failed', error: 'Image metadata extraction is disabled in settings' };
		}
		const ref = plugin.settings.imageMetadataExtractionModel;
		if (!ref) return { status: 'failed', error: 'No image metadata extraction model configured' };
		const provider = plugin.settings.providers.find(p => p.id === ref.providerId);
		const model = provider?.models.find(m => m.id === ref.modelId);
		if (!provider || !model) return { status: 'failed', error: 'Configured image metadata extraction model is missing' };
		if (!model.capabilities?.includes('image-extraction')) {
			return { status: 'failed', error: 'Configured model is not marked image-extraction capable' };
		}

		const imagePath = stringParam(job, 'imagePath');
		if (!imagePath) return { status: 'failed', error: 'Missing params.imagePath' };
		const image = localizedImageInfo(imagePath);
		if (!image) return { status: 'failed', error: `Image is not an MD5-named localized image: ${imagePath}` };
		const imageFile = plugin.app.vault.getAbstractFileByPath(image.path);
		if (!(imageFile instanceof TFile)) return { status: 'failed', error: `Image file not found: ${image.path}` };

		const schemaVersion = numberParam(job, 'schemaVersion') || plugin.settings.imageMetadataExtractionSchemaVersion || IMAGE_METADATA_SCHEMA_VERSION;
		const sourceNotePath = stringParam(job, 'sourceNotePath');
		if (await hasCurrentImageMetadataSidecar(plugin.app, image.sidecarPath, schemaVersion)) {
			await addImageMetadataSidecarSource(plugin.app, image.sidecarPath, sourceNotePath);
			return {
				status: 'done',
				outputPaths: [image.sidecarPath],
				notes: `Image metadata sidecar already current: ${image.sidecarPath}`,
			};
		}

		const reusable = await findReusableImageMetadataSidecar(plugin.app, image, schemaVersion);
		if (reusable) {
			await copyImageMetadataSidecar(plugin.app, image, reusable, {
				image,
				sourceNotePath,
				providerModel: ref,
				schemaVersion,
			});
			return {
				status: 'done',
				outputPaths: [image.sidecarPath],
				notes: `Copied image metadata sidecar from ${reusable.path}.`,
			};
		}

		const bytes = await plugin.app.vault.readBinary(imageFile);
		const result = await plugin.providerManager.extractImageMetadata(provider, model.id, bytes, imageMimeType(image.ext));
		await writeImageMetadataSidecar(plugin.app, {
			image,
			sourceNotePath,
			providerModel: ref,
			result,
			schemaVersion,
		});
		return {
			status: 'done',
			outputPaths: [image.sidecarPath],
			notes: `Extracted image metadata for ${image.path}.`,
		};
	}
}

function stringParam(job: OrchestrationJob, key: string): string {
	const value = job.params?.[key];
	return typeof value === 'string' ? value.trim() : '';
}

function numberParam(job: OrchestrationJob, key: string): number {
	const value = job.params?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
