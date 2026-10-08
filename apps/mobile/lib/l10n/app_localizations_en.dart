// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class L10nEn extends L10n {
  L10nEn([String locale = 'en']) : super(locale);

  @override
  String get appName => 'EventSnap';

  @override
  String get tagline => 'Capture  ·  Share  ·  Relive';

  @override
  String get events => 'My events';

  @override
  String get noEvents =>
      'No events yet. Scan a QR code or enter a code to join.';

  @override
  String get joinEvent => 'Join an event';

  @override
  String get scanQr => 'Scan QR code';

  @override
  String get enterCode => 'Enter code or link';

  @override
  String get codeOrLinkHint => 'Join code or link';

  @override
  String get codeOrLinkLabel => 'Code or link from the invitation';

  @override
  String get continueLabel => 'Continue';

  @override
  String get invalidLink => 'That is not a valid event link or code.';

  @override
  String get cameraDenied =>
      'Camera permission is needed to scan. You can enter the code instead.';

  @override
  String get joinCodeLabel => 'Join code';

  @override
  String get passcodeLabel => 'Event passcode';

  @override
  String get nameLabel => 'Your name (optional)';

  @override
  String get nameRequired => 'The host asks guests to enter a name.';

  @override
  String get phoneLabel => 'Mobile number';

  @override
  String get sendCode => 'Send code';

  @override
  String get smsCodeLabel => '6-digit code';

  @override
  String get verify => 'Verify';

  @override
  String get noticeTitle => 'Photo notice';

  @override
  String get noticeAccept =>
      'I have read the notice and agree to share my photos with this event.';

  @override
  String get noticeDraft => 'Draft text - pending legal review';

  @override
  String get join => 'Join event';

  @override
  String get joining => 'Joining…';

  @override
  String hostedBy(String host) {
    return 'Hosted by $host';
  }

  @override
  String get statusNotStarted => 'This event has not started yet.';

  @override
  String get statusClosed =>
      'Uploads are closed. You can still view the gallery.';

  @override
  String get statusUnavailable => 'This event is not available right now.';

  @override
  String get uploadsOff => 'Uploads are turned off for this event.';

  @override
  String get takePhoto => 'Take photo';

  @override
  String get choosePhotos => 'Choose from gallery';

  @override
  String get viewGallery => 'View gallery';

  @override
  String get galleryLocked =>
      'To browse the gallery, scan the gallery QR or enter its code.';

  @override
  String get unlockGallery => 'Unlock gallery';

  @override
  String get tabCapture => 'Capture';

  @override
  String get tabQueue => 'Uploads';

  @override
  String get tabGallery => 'Gallery';

  @override
  String get tabMine => 'Mine';

  @override
  String get queueEmpty => 'No uploads waiting.';

  @override
  String get uploadQueueTitle => 'Upload queue';

  @override
  String get queued => 'Waiting';

  @override
  String get preparing => 'Preparing…';

  @override
  String uploadingPct(int pct) {
    return 'Uploading $pct%';
  }

  @override
  String retryingIn(int seconds) {
    return 'Connection problem. Retrying in ${seconds}s';
  }

  @override
  String get waitingNetwork => 'Waiting for connection…';

  @override
  String get waitingWifi => 'Waiting for Wi-Fi to send the original';

  @override
  String get processing => 'Checking photo…';

  @override
  String get pendingApproval => 'Sent. Waiting for the host to approve.';

  @override
  String get approved => 'Visible in the gallery';

  @override
  String get rejected => 'Not published';

  @override
  String get failedLabel => 'Upload failed';

  @override
  String get duplicate => 'Already uploaded';

  @override
  String get cancelled => 'Cancelled';

  @override
  String get retry => 'Retry';

  @override
  String get cancel => 'Cancel';

  @override
  String get remove => 'Remove';

  @override
  String get deletePhoto => 'Delete my photo';

  @override
  String sentCount(int count) {
    return '$count photo(s) sent. Thank you!';
  }

  @override
  String capturedCount(int count) {
    return '$count photo(s) captured';
  }

  @override
  String get usePhoto => 'Add to queue';

  @override
  String get discard => 'Discard';

  @override
  String get draftsTitle => 'Drafts on this device';

  @override
  String get deleteDraft => 'Delete draft';

  @override
  String get draftsHint =>
      'Photos you captured but did not send yet. Deleting removes them from this device.';

  @override
  String get savedOnDevice =>
      'Saved on this device. Upload continues in the background when a connection is available.';

  @override
  String get galleryTitle => 'Gallery';

  @override
  String get galleryEmpty => 'No photos yet. Be the first to share one!';

  @override
  String get loadMore => 'Load more';

  @override
  String get highlights => 'Highlights';

  @override
  String get all => 'All';

  @override
  String get save => 'Save';

  @override
  String get saveToDevice => 'Save to device';

  @override
  String get saved => 'Saved';

  @override
  String get downloadOff => 'The host turned off downloads.';

  @override
  String get report => 'Report';

  @override
  String get reportTitle => 'Report this photo';

  @override
  String get reasonInappropriate => 'Inappropriate';

  @override
  String get reasonPrivacy => 'Privacy concern / remove me';

  @override
  String get reasonImpersonation => 'Impersonation';

  @override
  String get reasonCopyright => 'Copyright';

  @override
  String get reasonOther => 'Other';

  @override
  String get reportSend => 'Send report';

  @override
  String get reportThanks => 'Thank you. The host will review this photo.';

  @override
  String get settings => 'Settings';

  @override
  String get language => 'Language';

  @override
  String get dataSaver => 'Data saver';

  @override
  String get dataSaverHint =>
      'Smaller photos and fewer data. Recommended on mobile data.';

  @override
  String get wifiOnlyOriginals => 'Send originals on Wi-Fi only';

  @override
  String get wifiOnlyOriginalsHint =>
      'On mobile data a smaller version is sent. The original is sent only when you are on Wi-Fi.';

  @override
  String get notificationsLabel => 'Notifications';

  @override
  String get notificationsHint =>
      'Local alerts when your photos are approved or an event closes. No third-party push service is used.';

  @override
  String get dataUsage => 'Data used by uploads';

  @override
  String dataUsageMobile(String size) {
    return 'Mobile data: $size';
  }

  @override
  String dataUsageWifi(String size) {
    return 'Wi-Fi: $size';
  }

  @override
  String get dataUsageReset => 'Reset counters';

  @override
  String get leaveEvent => 'Leave event';

  @override
  String get leaveEventConfirm =>
      'Remove this event from this phone? Photos already uploaded stay in the gallery.';

  @override
  String get privacyRequests => 'Privacy and removal requests';

  @override
  String privacyBody(String host) {
    return 'To see, remove or restrict personal data, use the website: $host/privacy';
  }

  @override
  String ethiopianDate(String date) {
    return 'Ethiopian date: $date';
  }

  @override
  String get errGeneric => 'Something went wrong. Please try again.';

  @override
  String get errNetwork => 'No connection. Check your network and try again.';

  @override
  String get errRateLimited => 'Too many attempts. Please wait a moment.';

  @override
  String get errOtpInvalid => 'That code is not correct or has expired.';

  @override
  String get errEventNotFound =>
      'We could not find this event. Check the link or code.';

  @override
  String get errCredentialRequired =>
      'A code or passcode is needed to continue.';

  @override
  String get errConsentRequired => 'Please accept the photo notice to upload.';

  @override
  String get errFileTooLarge => 'This photo is too large (15 MB maximum).';

  @override
  String get errUnsupportedType =>
      'Only JPEG, PNG, WebP or HEIC photos are supported.';

  @override
  String get errStorageFull => 'This event has run out of storage.';

  @override
  String get errMediaLimit => 'This event reached its photo limit.';

  @override
  String get errOutsideWindow => 'Uploads are not open right now.';

  @override
  String get errSessionBlocked => 'You can no longer contribute to this event.';

  @override
  String get errSessionExpired =>
      'Your session expired. Open the event link again.';

  @override
  String get errEventState =>
      'This is not possible at this stage of the event.';

  @override
  String get people => 'People';

  @override
  String get you => 'You';

  @override
  String get guestUnnamed => 'Guest';

  @override
  String get yours => 'Yours';

  @override
  String get noPeople =>
      'No named senders yet. Photos appear here once guests add their name.';

  @override
  String get layoutGrid => 'Grid';

  @override
  String get layoutMasonry => 'Collage';

  @override
  String get layoutList => 'Large';

  @override
  String get layoutBySender => 'By sender';

  @override
  String photosCount(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count photos',
      one: '1 photo',
    );
    return '$_temp0';
  }

  @override
  String get minePhotosEmpty =>
      'You haven\'t added any photos to this event yet.';

  @override
  String get allPeople => 'All people';

  @override
  String get getStarted => 'Get started';

  @override
  String get splashPromise => 'Your memories,\nmade together.';
}
