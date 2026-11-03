#!/usr/bin/env python3
"""Submit one local ComfyUI MiniMax H3 reference-to-video job and wait for output."""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:8188'
REFERENCE = 'h3_pilotv_reference.png'
PREFIX = 'video/PilotV_H3_intro'


def api(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={'Content-Type': 'application/json'} if data else {})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


def main():
    p = {
        '1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'weight_dtype': 'default'}},
        '2': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'minimax_h3_video_vae_fp16.safetensors'}},
        '3': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'minimax_h3_audio_vae_fp32.safetensors'}},
        '4': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'type': 'minimax', 'device': 'default'}},
        '5': {'class_type': 'LoadImage', 'inputs': {'image': REFERENCE}},
        '6': {'class_type': 'MiniMaxH3ReferenceToVideo', 'inputs': {
            'clip': ['4', 0], 'vae': ['2', 0], 'audio_vae': ['3', 0],
            'prompt': ('A refined cinematic brand ident on a clean near-black background. Use reference image 1 as the exact PilotV wordmark identity: black/white typography and an unboxed V supported by a luminous electric-blue underline. A single blue point blooms into a thin light streak, travels beneath and reveals the standalone V; P, i, l, o, t then reveal individually from left to right ahead of V. Hold the complete PilotV logo steady and sharply legible at the end. Minimal premium technology aesthetic, controlled soft blue bloom, restrained elegant motion, locked-off camera, centered composition. No frames, no boxed V, no extra words, no other logos. Quiet atmospheric electronic musical swell and soft sparkling whoosh synchronized to the line, ending in a warm resolved chord, no speech.'),
            'width': 640, 'height': 352, 'length': 124, 'ref_image_size': 'match',
            'ref_images': {'ref_image_0': ['5', 0]},
        }},
        '7': {'class_type': 'MiniMaxH3SigmaShift', 'inputs': {'model': ['1', 0], 'shift_video': 12.0, 'shift_audio': 3.0}},
        '8': {'class_type': 'BasicScheduler', 'inputs': {'model': ['7', 0], 'scheduler': 'simple', 'steps': 20, 'denoise': 1.0}},
        '9': {'class_type': 'KSamplerSelect', 'inputs': {'sampler_name': 'res_multistep'}},
        '10': {'class_type': 'RandomNoise', 'inputs': {'noise_seed': 482167335}},
        '11': {'class_type': 'BasicGuider', 'inputs': {'model': ['7', 0], 'conditioning': ['6', 0]}},
        '12': {'class_type': 'SamplerCustomAdvanced', 'inputs': {'noise': ['10', 0], 'guider': ['11', 0], 'sampler': ['9', 0], 'sigmas': ['8', 0], 'latent_image': ['6', 1]}},
        '13': {'class_type': 'VAEDecode', 'inputs': {'samples': ['12', 0], 'vae': ['2', 0]}},
        '14': {'class_type': 'VAEDecodeAudio', 'inputs': {'samples': ['12', 1], 'vae': ['3', 0]}},
        '15': {'class_type': 'CreateVideo', 'inputs': {'images': ['13', 0], 'audio': ['14', 0], 'fps': 24}},
        '16': {'class_type': 'SaveVideo', 'inputs': {'video': ['15', 0], 'filename_prefix': PREFIX, 'format': 'mp4', 'codec': 'auto'}},
    }
    try:
        result = api('/prompt', {'prompt': p, 'client_id': 'pilotv-h3-ident-20261016'})
    except urllib.error.HTTPError as e:
        print('Submission rejected:', e.read().decode()[:4000], flush=True)
        return 2
    pid = result.get('prompt_id')
    print('H3 prompt_id:', pid, 'node_errors:', result.get('node_errors'), flush=True)
    if not pid:
        return 2
    for i in range(360):
        time.sleep(10)
        run = api('/history/' + pid).get(pid)
        if run:
            status = run.get('status', {})
            print('H3 status:', status.get('status_str'), flush=True)
            if status.get('status_str') == 'error':
                print('H3 messages:', json.dumps(status.get('messages', []), ensure_ascii=False)[-4000:], flush=True)
                return 1
            if status.get('completed'):
                print('H3 outputs:', json.dumps(run.get('outputs', {}), ensure_ascii=False)[:4000], flush=True)
                return 0
        elif i % 6 == 0:
            print('H3 working:', (i + 1) * 10, 'seconds', flush=True)
    print('H3 wait timeout; check task:', pid, flush=True)
    return 3


if __name__ == '__main__':
    sys.exit(main())
