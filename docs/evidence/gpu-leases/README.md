# GPU lease evidence

Generated with `node dashboard/test/gpu-evidence.mjs` against fixed NVIDIA
inventory and the original ACP peer fixtures, using actual Windows Job/Linux
cgroup ownership. The driver records runtime source bytes and sample counts;
saved Windows/Linux JSON and measured results are added after both runs finish.
No physical GPU allocation, real model, provider or power-loss test is implied.
