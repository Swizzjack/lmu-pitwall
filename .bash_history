cat /usr/local/lib/node_modules/@mariozechner/pi-coding-agent/docs/providers.md
cat /usr/local/lib/node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md
cat /usr/local/lib/node_modules/@mariozechner/pi-coding-agent/docs/models.md
ls -la ~/agent-work/pi-state/
find ~/agent-work/pi-state/ -type f
exit
ls -la /root/.pi/
ls -la /root/.pi/agent/
cat /root/.pi/agent/models.json | head -20
whoami
id
ls -la /root/ 2>/dev/null || echo "cant read /root"
ls -la /work/
cat > ~/agent-work/run-agent.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

exec podman run --rm -it \
  --name lmu-agent \
  --userns=keep-id \
  --security-opt=no-new-privileges \
  --cap-drop=ALL \
  --read-only \
  --tmpfs /tmp:rw,size=512m,mode=1777 \
  --tmpfs /home/agent/.cache:rw,size=2g \
  --tmpfs /home/agent/.npm:rw,size=512m \
  --tmpfs /home/agent/.config:rw,size=128m \
  --tmpfs /work/target:rw,size=8g \
  -v ~/agent-work/lmu-pitwall:/work:rw,Z \
  -v ~/agent-work/pi-state:/home/agent/.pi:rw,Z \
  --env-file ~/.config/pi-agent/nvidia.env \
  -e HOME=/home/agent \
  -e PI_CODING_AGENT_DIR=/home/agent/.pi/agent \
  --workdir /work \
  --network=slirp4netns \
  --memory=16g \
  --pids-limit=512 \
  lmu-agent-sandbox:latest \
  "$@"
EOF

chmod +x ~/agent-work/run-agent.sh
exit
