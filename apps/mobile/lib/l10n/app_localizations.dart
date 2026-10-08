import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_am.dart';
import 'app_localizations_en.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of L10n
/// returned by `L10n.of(context)`.
///
/// Applications need to include `L10n.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: L10n.localizationsDelegates,
///   supportedLocales: L10n.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the L10n.supportedLocales
/// property.
abstract class L10n {
  L10n(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static L10n of(BuildContext context) {
    return Localizations.of<L10n>(context, L10n)!;
  }

  static const LocalizationsDelegate<L10n> delegate = _L10nDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('am'),
    Locale('en'),
  ];

  /// No description provided for @appName.
  ///
  /// In en, this message translates to:
  /// **'EventSnap'**
  String get appName;

  /// No description provided for @tagline.
  ///
  /// In en, this message translates to:
  /// **'Capture  ·  Share  ·  Relive'**
  String get tagline;

  /// No description provided for @events.
  ///
  /// In en, this message translates to:
  /// **'My events'**
  String get events;

  /// No description provided for @noEvents.
  ///
  /// In en, this message translates to:
  /// **'No events yet. Scan a QR code or enter a code to join.'**
  String get noEvents;

  /// No description provided for @joinEvent.
  ///
  /// In en, this message translates to:
  /// **'Join an event'**
  String get joinEvent;

  /// No description provided for @scanQr.
  ///
  /// In en, this message translates to:
  /// **'Scan QR code'**
  String get scanQr;

  /// No description provided for @enterCode.
  ///
  /// In en, this message translates to:
  /// **'Enter code or link'**
  String get enterCode;

  /// No description provided for @codeOrLinkHint.
  ///
  /// In en, this message translates to:
  /// **'Join code or link'**
  String get codeOrLinkHint;

  /// No description provided for @codeOrLinkLabel.
  ///
  /// In en, this message translates to:
  /// **'Code or link from the invitation'**
  String get codeOrLinkLabel;

  /// No description provided for @continueLabel.
  ///
  /// In en, this message translates to:
  /// **'Continue'**
  String get continueLabel;

  /// No description provided for @invalidLink.
  ///
  /// In en, this message translates to:
  /// **'That is not a valid event link or code.'**
  String get invalidLink;

  /// No description provided for @cameraDenied.
  ///
  /// In en, this message translates to:
  /// **'Camera permission is needed to scan. You can enter the code instead.'**
  String get cameraDenied;

  /// No description provided for @joinCodeLabel.
  ///
  /// In en, this message translates to:
  /// **'Join code'**
  String get joinCodeLabel;

  /// No description provided for @passcodeLabel.
  ///
  /// In en, this message translates to:
  /// **'Event passcode'**
  String get passcodeLabel;

  /// No description provided for @nameLabel.
  ///
  /// In en, this message translates to:
  /// **'Your name (optional)'**
  String get nameLabel;

  /// No description provided for @nameRequired.
  ///
  /// In en, this message translates to:
  /// **'The host asks guests to enter a name.'**
  String get nameRequired;

  /// No description provided for @phoneLabel.
  ///
  /// In en, this message translates to:
  /// **'Mobile number'**
  String get phoneLabel;

  /// No description provided for @sendCode.
  ///
  /// In en, this message translates to:
  /// **'Send code'**
  String get sendCode;

  /// No description provided for @smsCodeLabel.
  ///
  /// In en, this message translates to:
  /// **'6-digit code'**
  String get smsCodeLabel;

  /// No description provided for @verify.
  ///
  /// In en, this message translates to:
  /// **'Verify'**
  String get verify;

  /// No description provided for @noticeTitle.
  ///
  /// In en, this message translates to:
  /// **'Photo notice'**
  String get noticeTitle;

  /// No description provided for @noticeAccept.
  ///
  /// In en, this message translates to:
  /// **'I have read the notice and agree to share my photos with this event.'**
  String get noticeAccept;

  /// No description provided for @noticeDraft.
  ///
  /// In en, this message translates to:
  /// **'Draft text - pending legal review'**
  String get noticeDraft;

  /// No description provided for @join.
  ///
  /// In en, this message translates to:
  /// **'Join event'**
  String get join;

  /// No description provided for @joining.
  ///
  /// In en, this message translates to:
  /// **'Joining…'**
  String get joining;

  /// No description provided for @hostedBy.
  ///
  /// In en, this message translates to:
  /// **'Hosted by {host}'**
  String hostedBy(String host);

  /// No description provided for @statusNotStarted.
  ///
  /// In en, this message translates to:
  /// **'This event has not started yet.'**
  String get statusNotStarted;

  /// No description provided for @statusClosed.
  ///
  /// In en, this message translates to:
  /// **'Uploads are closed. You can still view the gallery.'**
  String get statusClosed;

  /// No description provided for @statusUnavailable.
  ///
  /// In en, this message translates to:
  /// **'This event is not available right now.'**
  String get statusUnavailable;

  /// No description provided for @uploadsOff.
  ///
  /// In en, this message translates to:
  /// **'Uploads are turned off for this event.'**
  String get uploadsOff;

  /// No description provided for @takePhoto.
  ///
  /// In en, this message translates to:
  /// **'Take photo'**
  String get takePhoto;

  /// No description provided for @choosePhotos.
  ///
  /// In en, this message translates to:
  /// **'Choose from gallery'**
  String get choosePhotos;

  /// No description provided for @viewGallery.
  ///
  /// In en, this message translates to:
  /// **'View gallery'**
  String get viewGallery;

  /// No description provided for @galleryLocked.
  ///
  /// In en, this message translates to:
  /// **'To browse the gallery, scan the gallery QR or enter its code.'**
  String get galleryLocked;

  /// No description provided for @unlockGallery.
  ///
  /// In en, this message translates to:
  /// **'Unlock gallery'**
  String get unlockGallery;

  /// No description provided for @tabCapture.
  ///
  /// In en, this message translates to:
  /// **'Capture'**
  String get tabCapture;

  /// No description provided for @tabQueue.
  ///
  /// In en, this message translates to:
  /// **'Uploads'**
  String get tabQueue;

  /// No description provided for @tabGallery.
  ///
  /// In en, this message translates to:
  /// **'Gallery'**
  String get tabGallery;

  /// No description provided for @tabMine.
  ///
  /// In en, this message translates to:
  /// **'Mine'**
  String get tabMine;

  /// No description provided for @queueEmpty.
  ///
  /// In en, this message translates to:
  /// **'No uploads waiting.'**
  String get queueEmpty;

  /// No description provided for @uploadQueueTitle.
  ///
  /// In en, this message translates to:
  /// **'Upload queue'**
  String get uploadQueueTitle;

  /// No description provided for @queued.
  ///
  /// In en, this message translates to:
  /// **'Waiting'**
  String get queued;

  /// No description provided for @preparing.
  ///
  /// In en, this message translates to:
  /// **'Preparing…'**
  String get preparing;

  /// No description provided for @uploadingPct.
  ///
  /// In en, this message translates to:
  /// **'Uploading {pct}%'**
  String uploadingPct(int pct);

  /// No description provided for @retryingIn.
  ///
  /// In en, this message translates to:
  /// **'Connection problem. Retrying in {seconds}s'**
  String retryingIn(int seconds);

  /// No description provided for @waitingNetwork.
  ///
  /// In en, this message translates to:
  /// **'Waiting for connection…'**
  String get waitingNetwork;

  /// No description provided for @waitingWifi.
  ///
  /// In en, this message translates to:
  /// **'Waiting for Wi-Fi to send the original'**
  String get waitingWifi;

  /// No description provided for @processing.
  ///
  /// In en, this message translates to:
  /// **'Checking photo…'**
  String get processing;

  /// No description provided for @pendingApproval.
  ///
  /// In en, this message translates to:
  /// **'Sent. Waiting for the host to approve.'**
  String get pendingApproval;

  /// No description provided for @approved.
  ///
  /// In en, this message translates to:
  /// **'Visible in the gallery'**
  String get approved;

  /// No description provided for @rejected.
  ///
  /// In en, this message translates to:
  /// **'Not published'**
  String get rejected;

  /// No description provided for @failedLabel.
  ///
  /// In en, this message translates to:
  /// **'Upload failed'**
  String get failedLabel;

  /// No description provided for @duplicate.
  ///
  /// In en, this message translates to:
  /// **'Already uploaded'**
  String get duplicate;

  /// No description provided for @cancelled.
  ///
  /// In en, this message translates to:
  /// **'Cancelled'**
  String get cancelled;

  /// No description provided for @retry.
  ///
  /// In en, this message translates to:
  /// **'Retry'**
  String get retry;

  /// No description provided for @cancel.
  ///
  /// In en, this message translates to:
  /// **'Cancel'**
  String get cancel;

  /// No description provided for @remove.
  ///
  /// In en, this message translates to:
  /// **'Remove'**
  String get remove;

  /// No description provided for @deletePhoto.
  ///
  /// In en, this message translates to:
  /// **'Delete my photo'**
  String get deletePhoto;

  /// No description provided for @sentCount.
  ///
  /// In en, this message translates to:
  /// **'{count} photo(s) sent. Thank you!'**
  String sentCount(int count);

  /// No description provided for @capturedCount.
  ///
  /// In en, this message translates to:
  /// **'{count} photo(s) captured'**
  String capturedCount(int count);

  /// No description provided for @usePhoto.
  ///
  /// In en, this message translates to:
  /// **'Add to queue'**
  String get usePhoto;

  /// No description provided for @discard.
  ///
  /// In en, this message translates to:
  /// **'Discard'**
  String get discard;

  /// No description provided for @draftsTitle.
  ///
  /// In en, this message translates to:
  /// **'Drafts on this device'**
  String get draftsTitle;

  /// No description provided for @deleteDraft.
  ///
  /// In en, this message translates to:
  /// **'Delete draft'**
  String get deleteDraft;

  /// No description provided for @draftsHint.
  ///
  /// In en, this message translates to:
  /// **'Photos you captured but did not send yet. Deleting removes them from this device.'**
  String get draftsHint;

  /// No description provided for @savedOnDevice.
  ///
  /// In en, this message translates to:
  /// **'Saved on this device. Upload continues in the background when a connection is available.'**
  String get savedOnDevice;

  /// No description provided for @galleryTitle.
  ///
  /// In en, this message translates to:
  /// **'Gallery'**
  String get galleryTitle;

  /// No description provided for @galleryEmpty.
  ///
  /// In en, this message translates to:
  /// **'No photos yet. Be the first to share one!'**
  String get galleryEmpty;

  /// No description provided for @loadMore.
  ///
  /// In en, this message translates to:
  /// **'Load more'**
  String get loadMore;

  /// No description provided for @highlights.
  ///
  /// In en, this message translates to:
  /// **'Highlights'**
  String get highlights;

  /// No description provided for @all.
  ///
  /// In en, this message translates to:
  /// **'All'**
  String get all;

  /// No description provided for @save.
  ///
  /// In en, this message translates to:
  /// **'Save'**
  String get save;

  /// No description provided for @saveToDevice.
  ///
  /// In en, this message translates to:
  /// **'Save to device'**
  String get saveToDevice;

  /// No description provided for @saved.
  ///
  /// In en, this message translates to:
  /// **'Saved'**
  String get saved;

  /// No description provided for @downloadOff.
  ///
  /// In en, this message translates to:
  /// **'The host turned off downloads.'**
  String get downloadOff;

  /// No description provided for @report.
  ///
  /// In en, this message translates to:
  /// **'Report'**
  String get report;

  /// No description provided for @reportTitle.
  ///
  /// In en, this message translates to:
  /// **'Report this photo'**
  String get reportTitle;

  /// No description provided for @reasonInappropriate.
  ///
  /// In en, this message translates to:
  /// **'Inappropriate'**
  String get reasonInappropriate;

  /// No description provided for @reasonPrivacy.
  ///
  /// In en, this message translates to:
  /// **'Privacy concern / remove me'**
  String get reasonPrivacy;

  /// No description provided for @reasonImpersonation.
  ///
  /// In en, this message translates to:
  /// **'Impersonation'**
  String get reasonImpersonation;

  /// No description provided for @reasonCopyright.
  ///
  /// In en, this message translates to:
  /// **'Copyright'**
  String get reasonCopyright;

  /// No description provided for @reasonOther.
  ///
  /// In en, this message translates to:
  /// **'Other'**
  String get reasonOther;

  /// No description provided for @reportSend.
  ///
  /// In en, this message translates to:
  /// **'Send report'**
  String get reportSend;

  /// No description provided for @reportThanks.
  ///
  /// In en, this message translates to:
  /// **'Thank you. The host will review this photo.'**
  String get reportThanks;

  /// No description provided for @settings.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get settings;

  /// No description provided for @language.
  ///
  /// In en, this message translates to:
  /// **'Language'**
  String get language;

  /// No description provided for @dataSaver.
  ///
  /// In en, this message translates to:
  /// **'Data saver'**
  String get dataSaver;

  /// No description provided for @dataSaverHint.
  ///
  /// In en, this message translates to:
  /// **'Smaller photos and fewer data. Recommended on mobile data.'**
  String get dataSaverHint;

  /// No description provided for @wifiOnlyOriginals.
  ///
  /// In en, this message translates to:
  /// **'Send originals on Wi-Fi only'**
  String get wifiOnlyOriginals;

  /// No description provided for @wifiOnlyOriginalsHint.
  ///
  /// In en, this message translates to:
  /// **'On mobile data a smaller version is sent. The original is sent only when you are on Wi-Fi.'**
  String get wifiOnlyOriginalsHint;

  /// No description provided for @notificationsLabel.
  ///
  /// In en, this message translates to:
  /// **'Notifications'**
  String get notificationsLabel;

  /// No description provided for @notificationsHint.
  ///
  /// In en, this message translates to:
  /// **'Local alerts when your photos are approved or an event closes. No third-party push service is used.'**
  String get notificationsHint;

  /// No description provided for @dataUsage.
  ///
  /// In en, this message translates to:
  /// **'Data used by uploads'**
  String get dataUsage;

  /// No description provided for @dataUsageMobile.
  ///
  /// In en, this message translates to:
  /// **'Mobile data: {size}'**
  String dataUsageMobile(String size);

  /// No description provided for @dataUsageWifi.
  ///
  /// In en, this message translates to:
  /// **'Wi-Fi: {size}'**
  String dataUsageWifi(String size);

  /// No description provided for @dataUsageReset.
  ///
  /// In en, this message translates to:
  /// **'Reset counters'**
  String get dataUsageReset;

  /// No description provided for @leaveEvent.
  ///
  /// In en, this message translates to:
  /// **'Leave event'**
  String get leaveEvent;

  /// No description provided for @leaveEventConfirm.
  ///
  /// In en, this message translates to:
  /// **'Remove this event from this phone? Photos already uploaded stay in the gallery.'**
  String get leaveEventConfirm;

  /// No description provided for @privacyRequests.
  ///
  /// In en, this message translates to:
  /// **'Privacy and removal requests'**
  String get privacyRequests;

  /// No description provided for @privacyBody.
  ///
  /// In en, this message translates to:
  /// **'To see, remove or restrict personal data, use the website: {host}/privacy'**
  String privacyBody(String host);

  /// No description provided for @ethiopianDate.
  ///
  /// In en, this message translates to:
  /// **'Ethiopian date: {date}'**
  String ethiopianDate(String date);

  /// No description provided for @errGeneric.
  ///
  /// In en, this message translates to:
  /// **'Something went wrong. Please try again.'**
  String get errGeneric;

  /// No description provided for @errNetwork.
  ///
  /// In en, this message translates to:
  /// **'No connection. Check your network and try again.'**
  String get errNetwork;

  /// No description provided for @errRateLimited.
  ///
  /// In en, this message translates to:
  /// **'Too many attempts. Please wait a moment.'**
  String get errRateLimited;

  /// No description provided for @errOtpInvalid.
  ///
  /// In en, this message translates to:
  /// **'That code is not correct or has expired.'**
  String get errOtpInvalid;

  /// No description provided for @errEventNotFound.
  ///
  /// In en, this message translates to:
  /// **'We could not find this event. Check the link or code.'**
  String get errEventNotFound;

  /// No description provided for @errCredentialRequired.
  ///
  /// In en, this message translates to:
  /// **'A code or passcode is needed to continue.'**
  String get errCredentialRequired;

  /// No description provided for @errConsentRequired.
  ///
  /// In en, this message translates to:
  /// **'Please accept the photo notice to upload.'**
  String get errConsentRequired;

  /// No description provided for @errFileTooLarge.
  ///
  /// In en, this message translates to:
  /// **'This photo is too large (15 MB maximum).'**
  String get errFileTooLarge;

  /// No description provided for @errUnsupportedType.
  ///
  /// In en, this message translates to:
  /// **'Only JPEG, PNG, WebP or HEIC photos are supported.'**
  String get errUnsupportedType;

  /// No description provided for @errStorageFull.
  ///
  /// In en, this message translates to:
  /// **'This event has run out of storage.'**
  String get errStorageFull;

  /// No description provided for @errMediaLimit.
  ///
  /// In en, this message translates to:
  /// **'This event reached its photo limit.'**
  String get errMediaLimit;

  /// No description provided for @errOutsideWindow.
  ///
  /// In en, this message translates to:
  /// **'Uploads are not open right now.'**
  String get errOutsideWindow;

  /// No description provided for @errSessionBlocked.
  ///
  /// In en, this message translates to:
  /// **'You can no longer contribute to this event.'**
  String get errSessionBlocked;

  /// No description provided for @errSessionExpired.
  ///
  /// In en, this message translates to:
  /// **'Your session expired. Open the event link again.'**
  String get errSessionExpired;

  /// No description provided for @errEventState.
  ///
  /// In en, this message translates to:
  /// **'This is not possible at this stage of the event.'**
  String get errEventState;

  /// No description provided for @people.
  ///
  /// In en, this message translates to:
  /// **'People'**
  String get people;

  /// No description provided for @you.
  ///
  /// In en, this message translates to:
  /// **'You'**
  String get you;

  /// No description provided for @guestUnnamed.
  ///
  /// In en, this message translates to:
  /// **'Guest'**
  String get guestUnnamed;

  /// No description provided for @yours.
  ///
  /// In en, this message translates to:
  /// **'Yours'**
  String get yours;

  /// No description provided for @noPeople.
  ///
  /// In en, this message translates to:
  /// **'No named senders yet. Photos appear here once guests add their name.'**
  String get noPeople;

  /// No description provided for @layoutGrid.
  ///
  /// In en, this message translates to:
  /// **'Grid'**
  String get layoutGrid;

  /// No description provided for @layoutMasonry.
  ///
  /// In en, this message translates to:
  /// **'Collage'**
  String get layoutMasonry;

  /// No description provided for @layoutList.
  ///
  /// In en, this message translates to:
  /// **'Large'**
  String get layoutList;

  /// No description provided for @layoutBySender.
  ///
  /// In en, this message translates to:
  /// **'By sender'**
  String get layoutBySender;

  /// No description provided for @photosCount.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 photo} other{{count} photos}}'**
  String photosCount(int count);

  /// No description provided for @minePhotosEmpty.
  ///
  /// In en, this message translates to:
  /// **'You haven\'t added any photos to this event yet.'**
  String get minePhotosEmpty;

  /// No description provided for @allPeople.
  ///
  /// In en, this message translates to:
  /// **'All people'**
  String get allPeople;

  /// No description provided for @getStarted.
  ///
  /// In en, this message translates to:
  /// **'Get started'**
  String get getStarted;

  /// No description provided for @splashPromise.
  ///
  /// In en, this message translates to:
  /// **'Your memories,\nmade together.'**
  String get splashPromise;
}

class _L10nDelegate extends LocalizationsDelegate<L10n> {
  const _L10nDelegate();

  @override
  Future<L10n> load(Locale locale) {
    return SynchronousFuture<L10n>(lookupL10n(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['am', 'en'].contains(locale.languageCode);

  @override
  bool shouldReload(_L10nDelegate old) => false;
}

L10n lookupL10n(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'am':
      return L10nAm();
    case 'en':
      return L10nEn();
  }

  throw FlutterError(
    'L10n.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
