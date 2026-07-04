import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CommandResult = {
  stdout: string;
  stderr: string;
};

export type Neo4jProvisioningSpec = {
  apiKeyId: string;
  instanceId: string;
  userId: string;
  name: string;
  namespace: string;
  releaseName: string;
  secretName: string;
  username: string;
  password: string;
  storageSizeGb: number;
  cpuRequestMillicores: number;
  cpuLimitMillicores: number;
  memoryRequestMb: number;
  memoryLimitMb: number;
  plugins: string[];
};

export type Neo4jKubernetesResult = {
  statefulsetName: string;
  serviceName: string;
  pvcName: string | null;
  boltUrl: string;
  httpUrl: string;
  externalBoltUrl: string | null;
  externalHttpUrl: string | null;
  externalBoltPort: number | null;
};

export type Neo4jDeleteSpec = {
  namespace: string;
  releaseName: string;
  secretName: string;
  instanceId: string;
  externalBoltPort?: number | null;
};

type ExternalAccessConfig = {
  host: string;
  basePort: number;
  ingressNamespace: string;
  tcpConfigMap: string;
  ingressService: string;
  ingressClassName: string;
  dockerNetwork: string;
  kindNodeContainer: string;
};

/**
 * Local-dev-only exposure path: routes bolt through a shared ingress-nginx
 * TCP passthrough entry and the Neo4j Browser through a per-instance Ingress
 * on a nip.io hostname, then bridges the assigned NodePorts to the host via
 * docker proxy containers (kind nodes don't publish arbitrary host ports).
 * Disabled unless DBAAS_EXTERNAL_HOST is set, so it's a no-op outside local kind.
 */
export function getExternalAccessConfig(): ExternalAccessConfig | null {
  const enabled = (process.env.DBAAS_EXTERNAL_ACCESS_ENABLED ?? "true") !== "false";
  const host = process.env.DBAAS_EXTERNAL_HOST;

  if (!enabled || !host) {
    return null;
  }

  return {
    host,
    basePort: integerEnv("DBAAS_EXTERNAL_BOLT_BASE_PORT", 7687),
    ingressNamespace: process.env.DBAAS_INGRESS_NAMESPACE ?? "ingress-nginx",
    tcpConfigMap: process.env.DBAAS_INGRESS_TCP_CONFIGMAP ?? "ingress-nginx-tcp",
    ingressService: process.env.DBAAS_INGRESS_SERVICE ?? "ingress-nginx-controller",
    ingressClassName: process.env.DBAAS_INGRESS_CLASS_NAME ?? "nginx",
    dockerNetwork: process.env.DBAAS_EXTERNAL_DOCKER_NETWORK ?? "kind",
    kindNodeContainer:
      process.env.DBAAS_KIND_NODE_CONTAINER ?? "control-plane-dbaas-control-plane",
  };
}

export function tenantNamespace(apiKeyId: string) {
  return `cp-dbaas-${apiKeyId.replace(/-/g, "").slice(0, 18)}`;
}

export function releaseName(instanceId: string) {
  return `neo4j-${instanceId.replace(/-/g, "").slice(0, 18)}`;
}

export function secretName(instanceId: string) {
  return `${releaseName(instanceId)}-auth`;
}

export function serviceDns(namespace: string, serviceName: string, port: number) {
  return `${serviceName}.${namespace}.svc.cluster.local:${port}`;
}

export function getNeo4jFreeTierDefaults() {
  return {
    chart: process.env.DBAAS_NEO4J_HELM_CHART ?? "neo4j/neo4j",
    image: process.env.DBAAS_NEO4J_IMAGE ?? "neo4j:5.26-community",
    storageSizeGb: integerEnv("DBAAS_NEO4J_FREE_STORAGE_GB", 2),
    cpuRequestMillicores: integerEnv("DBAAS_NEO4J_FREE_CPU_REQUEST_MILLICORES", 250),
    cpuLimitMillicores: integerEnv("DBAAS_NEO4J_FREE_CPU_LIMIT_MILLICORES", 500),
    memoryRequestMb: integerEnv("DBAAS_NEO4J_FREE_MEMORY_REQUEST_MB", 2048),
    memoryLimitMb: integerEnv("DBAAS_NEO4J_FREE_MEMORY_LIMIT_MB", 2048),
    rolloutTimeoutSeconds: integerEnv("DBAAS_NEO4J_ROLLOUT_TIMEOUT_SECONDS", 420),
  };
}

export async function provisionNeo4jInKubernetes(
  spec: Neo4jProvisioningSpec,
): Promise<Neo4jKubernetesResult> {
  const defaults = getNeo4jFreeTierDefaults();
  await ensureNamespace(spec);

  const valuesDir = await mkdtemp(path.join(tmpdir(), "cp-neo4j-values-"));
  const valuesFile = path.join(valuesDir, "values.yaml");

  try {
    await writeFile(valuesFile, renderNeo4jValues(spec, defaults.image), "utf8");
    await run("helm", [
      "upgrade",
      "--install",
      spec.releaseName,
      defaults.chart,
      "--namespace",
      spec.namespace,
      "--values",
      valuesFile,
      "--wait",
      "--timeout",
      `${defaults.rolloutTimeoutSeconds}s`,
    ]);
  } finally {
    await rm(valuesDir, { recursive: true, force: true });
  }

  const podName = `${spec.releaseName}-0`;
  const statefulsetName = spec.releaseName;
  const serviceName = spec.releaseName;
  const pvcName = `data-${spec.releaseName}-0`;

  await run("kubectl", [
    "wait",
    "--for=condition=Ready",
    `pod/${podName}`,
    "-n",
    spec.namespace,
    "--timeout",
    `${defaults.rolloutTimeoutSeconds}s`,
  ]);

  await run("kubectl", ["get", "statefulset", statefulsetName, "-n", spec.namespace]);
  await run("kubectl", ["get", "svc", serviceName, "-n", spec.namespace]);

  const external = await exposeNeo4jExternally({
    namespace: spec.namespace,
    releaseName: spec.releaseName,
    serviceName,
  });

  return {
    statefulsetName,
    serviceName,
    pvcName,
    boltUrl: `bolt://${serviceDns(spec.namespace, serviceName, 7687)}`,
    httpUrl: `http://${serviceDns(spec.namespace, serviceName, 7474)}`,
    externalBoltUrl: external.externalBoltUrl,
    externalHttpUrl: external.externalHttpUrl,
    externalBoltPort: external.externalBoltPort,
  };
}

async function exposeNeo4jExternally(spec: {
  namespace: string;
  releaseName: string;
  serviceName: string;
}): Promise<{
  externalBoltUrl: string | null;
  externalHttpUrl: string | null;
  externalBoltPort: number | null;
}> {
  const config = getExternalAccessConfig();

  if (!config) {
    return { externalBoltUrl: null, externalHttpUrl: null, externalBoltPort: null };
  }

  const lbServiceName = `${spec.serviceName}-lb-neo4j`;
  const port = await allocateExternalBoltPort(config);

  await run("kubectl", [
    "patch",
    "configmap",
    config.tcpConfigMap,
    "-n",
    config.ingressNamespace,
    "--type",
    "merge",
    "-p",
    JSON.stringify({ data: { [String(port)]: `${spec.namespace}/${lbServiceName}:7687` } }),
  ]);

  const nodePort = await addServiceTcpPort(config, port);
  await createHostProxyContainer(config, port, nodePort);

  const host = `${spec.releaseName}.${config.host}.nip.io`;
  await createBrowserIngress(config, spec.namespace, spec.releaseName, lbServiceName, host);

  return {
    externalBoltUrl: `bolt://${config.host}:${port}`,
    externalHttpUrl: `http://${host}`,
    externalBoltPort: port,
  };
}

async function teardownNeo4jExternalAccess(spec: {
  namespace: string;
  releaseName: string;
  externalBoltPort?: number | null;
}) {
  const config = getExternalAccessConfig();

  await run("kubectl", [
    "delete",
    "ingress",
    `${spec.releaseName}-browser`,
    "-n",
    spec.namespace,
    "--ignore-not-found=true",
  ]);

  if (!config || !spec.externalBoltPort) {
    return;
  }

  await run("kubectl", [
    "patch",
    "configmap",
    config.tcpConfigMap,
    "-n",
    config.ingressNamespace,
    "--type",
    "merge",
    "-p",
    JSON.stringify({ data: { [String(spec.externalBoltPort)]: null } }),
  ]).catch(() => undefined);

  await removeServiceTcpPort(config, spec.externalBoltPort).catch(() => undefined);
  await removeHostProxyContainer(spec.externalBoltPort).catch(() => undefined);
}

async function allocateExternalBoltPort(config: ExternalAccessConfig): Promise<number> {
  const configMap = await getJson([
    "get",
    "configmap",
    config.tcpConfigMap,
    "-n",
    config.ingressNamespace,
    "-o",
    "json",
  ]).catch(() => null);

  const used = new Set<number>();
  for (const key of Object.keys(configMap?.data ?? {})) {
    const parsed = Number.parseInt(key, 10);
    if (Number.isFinite(parsed)) {
      used.add(parsed);
    }
  }

  let candidate = config.basePort;
  while (used.has(candidate)) {
    candidate += 1;
  }

  return candidate;
}

async function patchServicePorts(
  config: ExternalAccessConfig,
  mutate: (ports: ServicePort[]) => ServicePort[],
): Promise<void> {
  const service = await getJson([
    "get",
    "svc",
    config.ingressService,
    "-n",
    config.ingressNamespace,
    "-o",
    "json",
  ]);

  service.spec.ports = mutate(service.spec.ports ?? []);

  const tmpDir = await mkdtemp(path.join(tmpdir(), "cp-neo4j-svc-"));
  const file = path.join(tmpDir, "svc.json");

  try {
    await writeFile(file, JSON.stringify(service), "utf8");
    await run("kubectl", ["apply", "-f", file]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

type ServicePort = {
  name: string;
  port: number;
  targetPort?: number;
  protocol?: string;
  nodePort?: number;
};

async function addServiceTcpPort(config: ExternalAccessConfig, port: number): Promise<number> {
  await patchServicePorts(config, (ports) => {
    if (ports.some((existing) => existing.port === port)) {
      return ports;
    }

    return [
      ...ports,
      { name: `bolt-${port}`, port, targetPort: port, protocol: "TCP" },
    ];
  });

  const refreshed = await getJson([
    "get",
    "svc",
    config.ingressService,
    "-n",
    config.ingressNamespace,
    "-o",
    "json",
  ]);

  const match = (refreshed.spec.ports as ServicePort[]).find((p) => p.port === port);

  if (!match?.nodePort) {
    throw new Error(`Failed to allocate a NodePort for bolt port ${port}.`);
  }

  return match.nodePort;
}

async function removeServiceTcpPort(config: ExternalAccessConfig, port: number): Promise<void> {
  await patchServicePorts(config, (ports) => ports.filter((existing) => existing.port !== port));
}

async function createHostProxyContainer(
  config: ExternalAccessConfig,
  hostPort: number,
  nodePort: number,
): Promise<void> {
  const name = `cp-dbaas-bolt-${hostPort}`;
  const nodeIp = await getKindNodeIp(config);

  await run("docker", ["rm", "-f", name]).catch(() => undefined);
  await run("docker", [
    "run",
    "-d",
    "--name",
    name,
    "--network",
    config.dockerNetwork,
    "--restart",
    "unless-stopped",
    "-p",
    `${hostPort}:${hostPort}`,
    "alpine/socat",
    `TCP-LISTEN:${hostPort},fork,reuseaddr`,
    `TCP:${nodeIp}:${nodePort}`,
  ]);
}

async function removeHostProxyContainer(hostPort: number): Promise<void> {
  await run("docker", ["rm", "-f", `cp-dbaas-bolt-${hostPort}`]).catch(() => undefined);
}

async function getKindNodeIp(config: ExternalAccessConfig): Promise<string> {
  const result = await run("docker", [
    "inspect",
    config.kindNodeContainer,
    "--format",
    `{{(index .NetworkSettings.Networks "${config.dockerNetwork}").IPAddress}}`,
  ]);

  return result.stdout.trim();
}

async function createBrowserIngress(
  config: ExternalAccessConfig,
  namespace: string,
  releaseName: string,
  lbServiceName: string,
  host: string,
): Promise<void> {
  const manifest = [
    "apiVersion: networking.k8s.io/v1",
    "kind: Ingress",
    "metadata:",
    `  name: ${releaseName}-browser`,
    `  namespace: ${namespace}`,
    "  labels:",
    "    app.kubernetes.io/part-of: control-plane-dbaas",
    "    app.kubernetes.io/component: neo4j-external-http",
    "spec:",
    `  ingressClassName: ${config.ingressClassName}`,
    "  rules:",
    `    - host: ${host}`,
    "      http:",
    "        paths:",
    "          - path: /",
    "            pathType: Prefix",
    "            backend:",
    "              service:",
    `                name: ${lbServiceName}`,
    "                port:",
    "                  number: 7474",
    "",
  ].join("\n");

  const tmpDir = await mkdtemp(path.join(tmpdir(), "cp-neo4j-ingress-"));
  const file = path.join(tmpDir, "ingress.yaml");

  try {
    await writeFile(file, manifest, "utf8");
    await run("kubectl", ["apply", "-f", file]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function getJson(args: string[]): Promise<any> {
  const result = await run("kubectl", args);
  return JSON.parse(result.stdout);
}

export async function deleteNeo4jFromKubernetes(spec: Neo4jDeleteSpec) {
  await exportFinalBackup(spec);

  await run("helm", [
    "uninstall",
    spec.releaseName,
    "--namespace",
    spec.namespace,
    "--wait",
    "--timeout",
    "180s",
  ]).catch((error: unknown) => {
    if (!isNotFoundError(error)) {
      throw error;
    }
  });

  await run("kubectl", [
    "delete",
    "secret",
    spec.secretName,
    "-n",
    spec.namespace,
    "--ignore-not-found=true",
  ]);

  await run("kubectl", [
    "delete",
    "pvc",
    `data-${spec.releaseName}-0`,
    "-n",
    spec.namespace,
    "--ignore-not-found=true",
  ]);

  await teardownNeo4jExternalAccess(spec);
}

async function ensureNamespace(spec: Neo4jProvisioningSpec) {
  await run("kubectl", ["create", "namespace", spec.namespace]).catch((error: unknown) => {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  });

  await run("kubectl", [
    "label",
    "namespace",
    spec.namespace,
    "app.kubernetes.io/part-of=control-plane-dbaas",
    `control-plane.dev/api-key-id=${spec.apiKeyId}`,
    `control-plane.dev/user-id=${spec.userId}`,
    "--overwrite",
  ]);
}

function renderNeo4jValues(spec: Neo4jProvisioningSpec, image: string) {
  const [imageRepository, imageTag = "latest"] = image.split(":");

  return [
    "neo4j:",
    `  name: ${spec.releaseName}`,
    `  password: "${spec.password}"`,
    "  edition: community",
    '  acceptLicenseAgreement: "yes"',
    "  resources:",
    `    cpu: "${spec.cpuLimitMillicores}m"`,
    `    memory: "${spec.memoryLimitMb}Mi"`,
    "image:",
    `  repository: ${imageRepository}`,
    `  tag: ${imageTag}`,
    "volumes:",
    "  data:",
    "    mode: defaultStorageClass",
    "    defaultStorageClass:",
    "      requests:",
    `        storage: ${spec.storageSizeGb}Gi`,
    "services:",
    "  neo4j:",
    "    enabled: true",
    "    spec:",
    "      type: ClusterIP",
    "env:",
    `  NEO4J_PLUGINS: '${JSON.stringify(spec.plugins)}'`,
    "config:",
    '  dbms.security.procedures.unrestricted: "apoc.*,gds.*"',
    '  dbms.security.procedures.allowlist: "apoc.*,gds.*"',
    '  server.config.strict_validation.enabled: "false"',
    "podLabels:",
    "  app.kubernetes.io/part-of: control-plane-dbaas",
    "  app.kubernetes.io/component: neo4j",
    `  control-plane.dev/user-id: "${spec.userId}"`,
    `  control-plane.dev/api-key-id: "${spec.apiKeyId}"`,
    `  control-plane.dev/neo4j-instance-id: "${spec.instanceId}"`,
    '  control-plane.dev/tier: "free"',
    "",
  ].join("\n");
}

async function run(
  command: string,
  args: string[],
): Promise<CommandResult> {
  return execFileAsync(command, args, {
    maxBuffer: 1024 * 1024 * 5,
    timeout: 1000 * 60 * 10,
  });
}

async function exportFinalBackup(spec: Neo4jDeleteSpec) {
  const podName = `${spec.releaseName}-0`;
  const backupFile = `final-${spec.instanceId}.cypher`;
  const localBackupDir = path.join(tmpdir(), "control-plane-neo4j-backups");
  const auth = await getNeo4jAuth(spec);

  if (!auth) {
    return;
  }

  const exportResult = await run("kubectl", [
    "exec",
    "-n",
    spec.namespace,
    podName,
    "--",
    "cypher-shell",
    "-u",
    auth.username,
    "-p",
    auth.password,
    'CALL apoc.export.cypher.all(null, {stream: true, format: "cypher-shell"}) YIELD cypherStatements RETURN cypherStatements;',
  ]);

  await mkdir(localBackupDir, { recursive: true });
  await writeFile(path.join(localBackupDir, backupFile), exportResult.stdout, "utf8");
}

async function getNeo4jAuth(spec: Neo4jDeleteSpec) {
  const result = await run("kubectl", [
    "get",
    "secret",
    spec.secretName,
    "-n",
    spec.namespace,
    "-o",
    "jsonpath={.data.NEO4J_AUTH}",
  ]).catch(() => null);

  const encoded = result?.stdout.trim();
  if (!encoded) {
    return null;
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf("/");

  if (separator < 0) {
    return null;
  }

  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

function integerEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isAlreadyExistsError(error: unknown) {
  return error instanceof Error && error.message.includes("AlreadyExists");
}

function isNotFoundError(error: unknown) {
  return error instanceof Error && /not found|release: not found/i.test(error.message);
}
