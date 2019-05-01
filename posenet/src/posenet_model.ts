/**
 * @license
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import * as tf from '@tensorflow/tfjs';

import {CheckpointLoader} from './checkpoint_loader';
import {checkpoints, resnet50_checkpoints} from './checkpoints';
import {assertValidOutputStride, assertValidResolution, MobileNet, MobileNetMultiplier, OutputStride} from './mobilenet';
import {ModelWeights} from './model_weights';
import {decodeMultiplePoses} from './multi_pose/decode_multiple_poses';
import ResNet from './resnet';
import {decodeSinglePose} from './single_pose/decode_single_pose';
import {Pose, PosenetInput} from './types';
import {flipPosesHorizontal, getInputTensorDimensions, padAndResizeTo, scalePoses, toTensorBuffers3D} from './util';

export type PoseNetResolution = 161|193|257|289|321|353|385|417|449|481|513;
export type PoseNetArchitecture = 'ResNet50'|'MobileNetV1';
export type PoseNetDecodingMethod = 'single-person'|'multi-person';

export interface BaseModel {
  readonly inputResolution: PoseNetResolution;
  readonly outputStride: OutputStride;

  predict(input: tf.Tensor3D): {[key: string]: tf.Tensor3D};
  dispose(): void;
}

export interface InferenceConfig {
  flipHorizontal: boolean, decodingMethod: PoseNetDecodingMethod,
      maxDetections?: number, scoreThreshold?: number, nmsRadius?: number
}

export const SINGLE_PERSON_INFERENCE_CONFIG = {
  flipHorizontal: false,
  decodingMethod: 'single-person',
} as InferenceConfig;

export const MULTI_PERSON_INFERENCE_CONFIG = {
  flipHorizontal: false,
  decodingMethod: 'multi-person',
  maxDetections: 5,
  scoreThreshold: 0.5,
  nmsRadius: 20
} as InferenceConfig;

export class PoseNet {
  baseModel: BaseModel;

  constructor(net: BaseModel) {
    this.baseModel = net;
  }

  /**
   * Infer through PoseNet, and estimates multiple poses using the outputs.
   * This does standard ImageNet pre-processing before inferring through the
   * model. The image should pixels should have values [0-255]. It detects
   * multiple poses and finds their parts from part scores and displacement
   * vectors using a fast greedy decoding algorithm.  It returns up to
   * `maxDetections` object instance detections in decreasing root score order.
   *
   * @param input ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement)
   * The input image to feed through the network.
   *
   * @param imageScaleFactor  A number between 0.2 and 1. Defaults to 0.50. What
   * to scale the image by before feeding it through the network.  Set this
   * number lower to scale down the image and increase the speed when feeding
   * through the network at the cost of accuracy.
   *
   * @param flipHorizontal Defaults to false.  If the poses should be
   * flipped/mirrored  horizontally.  This should be set to true for videos
   * where the video is by default flipped horizontally (i.e. a webcam), and you
   * want the poses to be returned in the proper orientation.
   *
   * @param outputStride the desired stride for the outputs.  Must be 32, 16,
   * or 8. Defaults to 16. The output width and height will be will be
   * (inputSize - 1)/outputStride + 1
   *
   * @param maxDetections Maximum number of returned instance detections per
   * image. Defaults to 5.
   *
   * @param scoreThreshold Only return instance detections that have root part
   * score greater or equal to this value. Defaults to 0.5
   *
   * @param nmsRadius Non-maximum suppression part distance in pixels. It needs
   * to be strictly positive. Two parts suppress each other if they are less
   * than `nmsRadius` pixels away. Defaults to 20.
   *
   * @return An array of poses and their scores, each containing keypoints and
   * the corresponding keypoint scores.  The positions of the keypoints are
   * in the same scale as the original image
   */
  async estimatePoses(
      input: PosenetInput,
      config: InferenceConfig = MULTI_PERSON_INFERENCE_CONFIG):
      Promise<Pose[]> {
    const outputStride = this.baseModel.outputStride;
    const inputResolution = this.baseModel.inputResolution;
    assertValidOutputStride(outputStride);
    assertValidResolution(this.baseModel.inputResolution, outputStride);

    const [height, width] = getInputTensorDimensions(input);
    let [resizedHeight, resizedWidth] = [0, 0];
    let [padTop, padBottom, padLeft, padRight] = [0, 0, 0, 0];
    let heatmapScores, offsets, displacementFwd, displacementBwd;

    resizedHeight = inputResolution;
    resizedWidth = inputResolution;

    const outputs = tf.tidy(() => {
      const {resized, paddedBy} =
          padAndResizeTo(input, [resizedHeight, resizedWidth]);
      padTop = paddedBy[0][0];
      padBottom = paddedBy[0][1];
      padLeft = paddedBy[1][0];
      padRight = paddedBy[1][1];
      return this.baseModel.predict(resized);
    });
    heatmapScores = outputs.heatmapScores;
    offsets = outputs.offsets;
    displacementFwd = outputs.displacementFwd;
    displacementBwd = outputs.displacementBwd;


    const [scoresBuffer, offsetsBuffer, displacementsFwdBuffer, displacementsBwdBuffer] =
        await toTensorBuffers3D(
            [heatmapScores, offsets, displacementFwd, displacementBwd]);

    let poses;
    if (config.decodingMethod === 'multi-person') {
      poses = await decodeMultiplePoses(
          scoresBuffer, offsetsBuffer, displacementsFwdBuffer,
          displacementsBwdBuffer, outputStride, config.maxDetections,
          config.scoreThreshold, config.nmsRadius);
    } else {
      const pose = await decodeSinglePose(heatmapScores, offsets, outputStride);
      poses = [pose];
    }

    const scaleY = (height + padTop + padBottom) / (resizedHeight);
    const scaleX = (width + padLeft + padRight) / (resizedWidth);
    let scaledPoses = scalePoses(poses, scaleY, scaleX, -padTop, -padLeft);

    if (config.flipHorizontal) {
      scaledPoses = flipPosesHorizontal(scaledPoses, width)
    }

    heatmapScores.dispose();
    offsets.dispose();
    displacementFwd.dispose();
    displacementBwd.dispose();

    return scaledPoses;
  }

  public dispose() {
    this.baseModel.dispose();
  }
}

/**
 * Loads the PoseNet model instance from a checkpoint, with the MobileNet
 * architecture specified by the multiplier.
 *
 * @param multiplier An optional number with values: 1.01, 1.0, 0.75, or
 * 0.50. Defaults to 1.01. It is the float multiplier for the depth (number of
 * channels) for all convolution ops. The value corresponds to a MobileNet
 * architecture and checkpoint.  The larger the value, the larger the size of
 * the layers, and more accurate the model at the cost of speed.  Set this to
 * a smaller value to increase speed at the cost of accuracy.
 *
 */
export async function loadMobileNet(config: ModelConfig): Promise<PoseNet> {
  const multiplier = config.multiplier;
  if (tf == null) {
    throw new Error(
        `Cannot find TensorFlow.js. If you are using a <script> tag, please ` +
        `also include @tensorflow/tfjs on the page before using this
        model.`);
  }
  // TODO: figure out better way to decide below.
  const possibleMultipliers = Object.keys(checkpoints);
  tf.util.assert(
      typeof multiplier === 'number',
      () => `got multiplier type of ${typeof multiplier} when it should be a ` +
          `number.`);

  tf.util.assert(
      possibleMultipliers.indexOf(multiplier.toString()) >= 0,
      () => `invalid multiplier value of ${
                multiplier}.  No checkpoint exists for that ` +
          `multiplier. Must be one of ${possibleMultipliers.join(',')}.`);

  const mobileNet: MobileNet = await mobilenetLoader.load(config);

  return new PoseNet(mobileNet);
}

export const mobilenetLoader = {
  load: async(config: ModelConfig): Promise<MobileNet> => {
    const checkpoint = checkpoints[config.multiplier];

    const checkpointLoader = new CheckpointLoader(checkpoint.url);

    const variables = await checkpointLoader.getAllVariables();

    const weights = new ModelWeights(variables);

    return new MobileNet(
        weights, checkpoint.architecture, config.inputResolution,
        config.outputStride);
  },

};

/**
 * Loads the PoseNet model instance from a checkpoint, with the ResNet
 * architecture.
 *
 * @param outputStride Specifies the output stride of the ResNet model.
 * The smaller the value, the larger the output resolution, and more accurate
 * the model at the cost of speed.  Set this to a larger value to increase speed
 * at the cost of accuracy. Currently only 32 is supported for ResNet.
 *
 * @param resolution Specifies the input resolution of the ResNet model.
 * The larger the value, more accurate the model at the cost of speed.
 * Set this to a smaller value to increase speed at the cost of accuracy.
 * Currently only input resolution 257 and 513 are supported for ResNet.
 *
 */
export async function loadResNet(config: ModelConfig): Promise<PoseNet> {
  const inputResolution = config.inputResolution;
  const outputStride = config.outputStride;
  if (tf == null) {
    throw new Error(
        `Cannot find TensorFlow.js. If you are using a <script> tag, please ` +
        `also include @tensorflow/tfjs on the page before using this
        model.`);
  }

  tf.util.assert(
      [32].indexOf(outputStride) >= 0,
      () => `invalid stride value of ${
                outputStride}.  No checkpoint exists for that ` +
          `stride. Currently must be one of [32].`);

  tf.util.assert(
      [513, 257].indexOf(inputResolution) >= 0,
      () => `invalid resolution value of ${
                inputResolution}.  No checkpoint exists for that ` +
          `resolution. Currently must be one of [513, 257].`);

  const graphModel = await tf.loadGraphModel(
      resnet50_checkpoints[inputResolution][outputStride]);
  const resnet = new ResNet(graphModel, inputResolution, outputStride);
  return new PoseNet(resnet);
}

export interface ModelConfig {
  architecture: PoseNetArchitecture, outputStride: OutputStride,
      inputResolution: PoseNetResolution, multiplier?: MobileNetMultiplier
}

export const DEFAULT_RESNET_CONFIG = {
  architecture: 'ResNet50',
  outputStride: 32,
  inputResolution: 257,
  multiplier: 1.0  // multiplier is not used by ResNet
} as ModelConfig;

export const DEFAULT_MOBILENET_V1_CONFIG = {
  architecture: 'MobileNetV1',
  outputStride: 16,
  inputResolution: 513,
  multiplier: 0.75
} as ModelConfig;

export async function load(config: ModelConfig = DEFAULT_MOBILENET_V1_CONFIG):
    Promise<PoseNet> {
  if (config.architecture === 'ResNet50') {
    return loadResNet(config);
  } else if (config.architecture === 'MobileNetV1') {
    return loadMobileNet(config);
  } else {
    return null;
  }
}
