# fly.toml - Fly.io deployment config for SIAS API
# Replace "sias-api-auracarat" with your own app name

app = "sias-api-auracarat"
primary_region = "sin"  # Singapore — closest to India

[build]
  # Uses the Dockerfile in this folder

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = true   # Saves cost when idle
  auto_start_machines = true
  min_machines_running = 0

  [http_service.concurrency]
    type = "requests"
    hard_limit = 100
    soft_limit = 80

[[vm]]
  memory = "256mb"    # Small is fine for this API
  cpu_kind = "shared"
  cpus = 1
