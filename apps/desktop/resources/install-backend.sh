#!/bin/sh
set -eu

DOCKER_VERSION="28.5.0"
DOKPLOY_IMAGE="${DOKPLOY_IMAGE:-dokploy/dokploy:v0.30.6}"
ADVERTISE_ADDR="${ADVERTISE_ADDR:?ADVERTISE_ADDR is required}"

if [ "$(id -u)" != "0" ]; then
	echo "This installer must run as root" >&2
	exit 1
fi

if [ "$(uname -s)" != "Linux" ] || [ -f /.dockerenv ]; then
	echo "A non-container Linux server is required" >&2
	exit 1
fi

echo "1/7 Checking ports"
if ! docker service inspect dokploy >/dev/null 2>&1; then
	for port in 80 443 3000; do
		if ss -tuln | grep -q ":${port} "; then
			echo "Port ${port} is already in use" >&2
			exit 1
		fi
	done
fi

echo "2/7 Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
	curl -fsSL https://get.docker.com | sh -s -- --version "$DOCKER_VERSION"
fi

echo "3/7 Initializing Docker Swarm"
if [ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)" != "active" ]; then
	docker swarm init --advertise-addr "$ADVERTISE_ADDR"
fi
docker network inspect dokploy-network >/dev/null 2>&1 || \
	docker network create --driver overlay --attachable dokploy-network

echo "4/7 Creating secrets and storage"
mkdir -p /etc/dokploy
chmod 700 /etc/dokploy
if ! docker secret inspect dokploy_postgres_password >/dev/null 2>&1; then
	openssl rand -base64 32 | tr -d '=+/' | cut -c1-32 | \
		docker secret create dokploy_postgres_password -
fi
if ! docker secret inspect dokploy_auth_secret >/dev/null 2>&1; then
	openssl rand -hex 32 | docker secret create dokploy_auth_secret -
fi

echo "5/7 Starting PostgreSQL"
if ! docker service inspect dokploy-postgres >/dev/null 2>&1; then
	docker service create \
		--name dokploy-postgres \
		--constraint 'node.role==manager' \
		--network dokploy-network \
		--env POSTGRES_USER=dokploy \
		--env POSTGRES_DB=dokploy \
		--secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
		--env POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
		--mount type=volume,source=dokploy-postgres,target=/var/lib/postgresql/data \
		postgres:16
fi

echo "6/7 Starting Dokploy API backend"
if docker service inspect dokploy >/dev/null 2>&1; then
	docker service update \
		--image "$DOKPLOY_IMAGE" \
		--env-add DOKPLOY_DESKTOP_ONLY=true \
		dokploy
else
	docker service create \
		--name dokploy \
		--replicas 1 \
		--network dokploy-network \
		--mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
		--mount type=bind,source=/etc/dokploy,target=/etc/dokploy \
		--mount type=volume,source=dokploy,target=/root/.docker \
		--secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
		--secret source=dokploy_auth_secret,target=/run/secrets/dokploy_auth_secret \
		--publish published=3000,target=3000,mode=host \
		--update-parallelism 1 \
		--update-order stop-first \
		--constraint 'node.role == manager' \
		--env POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
		--env BETTER_AUTH_SECRET_FILE=/run/secrets/dokploy_auth_secret \
		--env DOKPLOY_DESKTOP_ONLY=true \
		"$DOKPLOY_IMAGE"
fi

echo "7/7 Starting Traefik"
attempt=0
while [ ! -f /etc/dokploy/traefik/traefik.yml ] && [ "$attempt" -lt 30 ]; do
	attempt=$((attempt + 1))
	sleep 2
done
if [ ! -f /etc/dokploy/traefik/traefik.yml ]; then
	echo "Dokploy did not create its Traefik configuration in time" >&2
	exit 1
fi
if ! docker inspect dokploy-traefik >/dev/null 2>&1; then
	docker run -d \
		--name dokploy-traefik \
		--restart always \
		--network dokploy-network \
		-v /etc/dokploy/traefik/traefik.yml:/etc/traefik/traefik.yml \
		-v /etc/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic \
		-v /var/run/docker.sock:/var/run/docker.sock:ro \
		-p 80:80/tcp \
		-p 443:443/tcp \
		-p 443:443/udp \
		traefik:v3.6.7
fi

echo "Dokploy backend installed at http://${ADVERTISE_ADDR}:3000"
