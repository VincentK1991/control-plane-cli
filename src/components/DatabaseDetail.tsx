import { ArrowLeft, Command, FileText, RefreshCw, UploadCloud } from "lucide-react";
import * as React from "react";
import StatusPill from "./StatusPill";

type UserProfile = {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
};

type Neo4jInstance = {
  id: string;
  api_key_id: string;
  name: string;
  status: "provisioning" | "ready" | "failed" | "deleting" | "deleted";
  namespace: string;
  bolt_url: string | null;
  http_url: string | null;
  external_bolt_url: string | null;
  external_http_url: string | null;
  storage_size_gb: number;
  memory_limit_mb: number;
  last_error: string | null;
  created_at: string;
};

type DocumentIndexingJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  current_step: string | null;
  progress: Record<string, { nodeCount?: number; relationshipCount?: number }>;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const ACCEPTED_EXTENSIONS = [".txt", ".md", ".markdown"];
const MAX_FILE_BYTES = 200_000;
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

async function apiRequest<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });

  const data = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Request failed.");
  }

  return data;
}

function hasAcceptedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function progressSummary(job: DocumentIndexingJob): string | null {
  const writeStep = job.progress?.["writing-graph-to-instance"];
  if (!writeStep) {
    return null;
  }
  const parts: string[] = [];
  if (typeof writeStep.nodeCount === "number") {
    parts.push(`${writeStep.nodeCount} nodes`);
  }
  if (typeof writeStep.relationshipCount === "number") {
    parts.push(`${writeStep.relationshipCount} relationships`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

export default function DatabaseDetail({ instanceId }: { instanceId: string }) {
  const [profile, setProfile] = React.useState<UserProfile | null>(null);
  const [sessionStatus, setSessionStatus] = React.useState<"checking" | "ready">(
    "checking",
  );
  const [instance, setInstance] = React.useState<Neo4jInstance | null>(null);
  const [jobs, setJobs] = React.useState<DocumentIndexingJob[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selectedFile, setSelectedFile] = React.useState<{
    name: string;
    content: string;
  } | null>(null);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    apiRequest<{ user: UserProfile }>("/api/me")
      .then(({ user }) => setProfile(user))
      .catch(() => setProfile(null))
      .finally(() => setSessionStatus("ready"));
  }, []);

  const refreshInstance = React.useCallback(() => {
    apiRequest<{ instance: Neo4jInstance }>(`/api/neo4j/${instanceId}`)
      .then(({ instance }) => {
        setInstance(instance);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Unable to load database.");
      });
  }, [instanceId]);

  const refreshJobs = React.useCallback(() => {
    apiRequest<{ jobs: DocumentIndexingJob[] }>(`/api/neo4j/${instanceId}/documents`)
      .then(({ jobs }) => setJobs(jobs))
      .catch(() => undefined);
  }, [instanceId]);

  React.useEffect(() => {
    if (!profile) {
      return;
    }
    refreshInstance();
    refreshJobs();
  }, [profile, refreshInstance, refreshJobs]);

  // Poll while any job is still in flight so progress/status updates show
  // up without a manual refresh.
  React.useEffect(() => {
    if (!profile) {
      return;
    }
    const hasActiveJob = jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status));
    if (!hasActiveJob) {
      return;
    }
    const interval = setInterval(refreshJobs, 2000);
    return () => clearInterval(interval);
  }, [profile, jobs, refreshJobs]);

  const handleFileChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      setUploadError(null);
      setSelectedFile(null);

      if (!file) {
        return;
      }
      if (!hasAcceptedExtension(file.name)) {
        setUploadError("Only .txt and .md files are supported.");
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setUploadError(`File is too large (max ${MAX_FILE_BYTES / 1000}KB).`);
        return;
      }

      file
        .text()
        .then((content) => setSelectedFile({ name: file.name, content }))
        .catch(() => setUploadError("Unable to read file."));
    },
    [],
  );

  const uploadDocument = React.useCallback(
    (event: { preventDefault: () => void }) => {
      event.preventDefault();
      if (!selectedFile) {
        return;
      }

      setUploading(true);
      setUploadError(null);

      apiRequest<{ jobId: string }>(`/api/neo4j/${instanceId}/documents`, {
        method: "POST",
        body: JSON.stringify({ content: selectedFile.content }),
      })
        .then(() => {
          setSelectedFile(null);
          if (fileInputRef.current) {
            fileInputRef.current.value = "";
          }
          refreshJobs();
        })
        .catch((error: unknown) => {
          setUploadError(
            error instanceof Error ? error.message : "Unable to start document indexing.",
          );
        })
        .finally(() => setUploading(false));
    },
    [instanceId, selectedFile, refreshJobs],
  );

  if (sessionStatus === "checking") {
    return (
      <div className="grid min-h-screen place-items-center bg-[#f7f8fb] px-4 text-center">
        <p className="text-sm font-medium text-slate-600">Checking session...</p>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#f7f8fb] px-4 text-center">
        <div>
          <p className="text-sm font-medium text-slate-600">
            Sign in to view this database.
          </p>
          <a
            className="mt-4 inline-flex h-10 items-center justify-center rounded-md bg-teal-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700"
            href="/"
          >
            Go to dashboard
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f7f8fb] text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white">
            <Command className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-5">Control Plane</p>
            <p className="text-xs text-slate-500">Database detail</p>
          </div>
          <a
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:border-slate-300"
            href="/"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Dashboard
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        {loadError && (
          <div className="mb-6 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {loadError}
          </div>
        )}

        {instance && (
          <>
            <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h1 className="text-2xl font-semibold tracking-normal text-slate-950">
                    {instance.name}
                  </h1>
                  <p className="mt-1 font-mono text-xs text-slate-500">{instance.id}</p>
                </div>
                <StatusPill status={instance.status} />
              </div>

              <dl className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <dt className="text-xs font-medium uppercase text-slate-400">
                    Bolt URL
                  </dt>
                  <dd className="mt-1 break-all font-mono text-xs text-slate-700">
                    {instance.external_bolt_url ?? instance.bolt_url ?? "Pending"}
                  </dd>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <dt className="text-xs font-medium uppercase text-slate-400">
                    Browser
                  </dt>
                  <dd className="mt-1 break-all font-mono text-xs text-slate-700">
                    {instance.external_http_url ? (
                      <a
                        className="text-teal-700 underline"
                        href={instance.external_http_url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {instance.external_http_url}
                      </a>
                    ) : (
                      (instance.http_url ?? "Pending")
                    )}
                  </dd>
                </div>
              </dl>

              {instance.status !== "ready" && (
                <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-800">
                  {instance.status === "provisioning"
                    ? "This database is still provisioning. Document uploads are disabled until it's ready."
                    : instance.last_error
                      ? `Database status: ${instance.status}. ${instance.last_error}`
                      : `Database status: ${instance.status}. Document uploads are disabled.`}
                </div>
              )}
            </section>

            <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4">
                <h2 className="text-base font-semibold">Upload a document</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Uploads a .txt or .md file to the document-indexing pipeline, which
                  extracts entities and relationships (GPT-4o-mini) and writes them
                  into this database as a graph.
                </p>
              </div>

              <form className="flex flex-col gap-3 sm:flex-row sm:items-center" onSubmit={uploadDocument}>
                <input
                  accept=".txt,.md,.markdown"
                  className="block w-full flex-1 text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
                  disabled={instance.status !== "ready" || uploading}
                  onChange={handleFileChange}
                  ref={fileInputRef}
                  type="file"
                />
                <button
                  className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md bg-teal-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  disabled={!selectedFile || instance.status !== "ready" || uploading}
                  type="submit"
                >
                  <UploadCloud className="h-4 w-4" aria-hidden="true" />
                  {uploading ? "Uploading..." : "Upload & Index"}
                </button>
              </form>

              {selectedFile && (
                <p className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  {selectedFile.name} (
                  {new TextEncoder().encode(selectedFile.content).length} bytes)
                </p>
              )}

              {uploadError && (
                <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {uploadError}
                </div>
              )}
            </section>

            <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 p-4">
                <div>
                  <h2 className="text-base font-semibold">Indexing jobs</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Each upload starts a Temporal workflow job; status updates while
                    it's queued or running.
                  </p>
                </div>
                <button
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:border-slate-300"
                  onClick={refreshJobs}
                  type="button"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  Refresh
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Job</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold">Step</th>
                      <th className="px-4 py-3 font-semibold">Result</th>
                      <th className="px-4 py-3 font-semibold">Started</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {jobs.map((job) => (
                      <tr key={job.id}>
                        <td className="px-4 py-3 font-mono text-xs text-slate-600">
                          {job.id.slice(0, 8)}
                        </td>
                        <td className="px-4 py-3">
                          <StatusPill status={job.status} />
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-600">
                          {job.current_step ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-600">
                          {job.status === "failed"
                            ? (job.error ?? "Failed")
                            : (progressSummary(job) ?? "—")}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-500">
                          {new Date(job.created_at).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                    {jobs.length === 0 && (
                      <tr>
                        <td className="px-4 py-8 text-center text-slate-500" colSpan={5}>
                          No documents uploaded yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
