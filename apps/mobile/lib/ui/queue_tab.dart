import 'dart:async';

import 'package:flutter/material.dart';

import '../data/file_ops.dart';
import '../data/models.dart';
import '../l10n/app_localizations.dart';
import '../services/app_services.dart';
import 'common.dart';

/// Per-item progress, retry, cancel and failure reasons. The queue lives in SQLite: it is still here after the app is killed.
class QueueTab extends StatefulWidget {
  const QueueTab({super.key, required this.event});
  final JoinedEvent event;
  @override
  State<QueueTab> createState() => _QueueTabState();
}

class _QueueTabState extends State<QueueTab> {
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _poll = Timer.periodic(const Duration(seconds: 6), (_) {
      if (mounted) Services.of(context).syncStatuses();
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  String _label(L10n l, UploadItem i) {
    switch (i.state) {
      case UploadState.preparing:
        return l.preparing;
      case UploadState.queued:
        return l.queued;
      case UploadState.uploading:
        return l.uploadingPct(i.progress);
      case UploadState.retrying:
        return l.retryingIn(((i.retryInMs ?? 0) / 1000).round());
      case UploadState.waitingNetwork:
        return l.waitingNetwork;
      case UploadState.waitingWifi:
        return l.waitingWifi;
      case UploadState.processing:
        return l.processing;
      case UploadState.failed:
        return '${l.failedLabel}: ${errorText(l, i.error)}';
      case UploadState.cancelled:
        return l.cancelled;
      case UploadState.done:
        return switch (i.serverState) {
          'approved' => l.approved,
          'pending' => l.pendingApproval,
          'rejected' || 'hidden' || 'deleted' || 'flagged' => l.rejected,
          'duplicate' => l.duplicate,
          'failed' => l.failedLabel,
          _ => l.processing,
        };
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    final engine = Services.of(context).engine;
    return StreamBuilder<List<UploadItem>>(
      stream: engine.stream,
      initialData: engine.items,
      builder: (c, snap) {
        final items = (snap.data ?? const <UploadItem>[]).where((i) => i.eventLocator == widget.event.locator && i.state != UploadState.cancelled).toList().reversed.toList();
        if (items.isEmpty) return Center(child: Text(l.queueEmpty));
        final sent = items.where((i) => i.state == UploadState.done).length;
        return ListView(padding: const EdgeInsets.all(12), children: [
          if (sent > 0 && sent == items.length) Card(color: const Color(0xFFE3F6EC), child: Padding(padding: const EdgeInsets.all(12), child: Text(l.sentCount(sent)))),
          Text(l.uploadQueueTitle, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          for (final i in items)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: Row(children: [
                  ClipRRect(borderRadius: BorderRadius.circular(8), child: fileExistsSync(i.path) ? photoImage(i.path, width: 56, height: 56, cacheWidth: 112) : const SizedBox(width: 56, height: 56, child: Icon(Icons.image_not_supported))),
                  const SizedBox(width: 12),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(fmtBytes(i.size), style: Theme.of(context).textTheme.bodySmall),
                    Text(_label(l, i)),
                    if (i.isActive) Padding(padding: const EdgeInsets.only(top: 4), child: LinearProgressIndicator(value: i.progress / 100)),
                  ])),
                  if (i.isActive) IconButton(tooltip: l.cancel, icon: const Icon(Icons.close), onPressed: () => engine.cancel(i.id)),
                  if (i.state == UploadState.failed) IconButton(tooltip: l.retry, icon: const Icon(Icons.refresh), onPressed: () => engine.retry(i.id)),
                  if (i.state == UploadState.failed || i.state == UploadState.done) IconButton(tooltip: l.remove, icon: const Icon(Icons.delete_outline), onPressed: () => engine.remove(i.id, deleteFile: true)),
                ]),
              ),
            ),
        ]);
      },
    );
  }
}
