/**
 * Labels of Google's share dialog (the `drivesharing` iframe shared by Docs, Sheets,
 * Slides and Vids) and of the editor's File-menu dialogs (copy, move, export).
 * Observed on 2026-09-24 with hl=en.
 */
export const SHARE_LABELS = {
  /** The editor's Share button: "Share. Private to only me.", "Share. Anyone with the link." … */
  openButton: /^Share\. /,
  frame: 'iframe[src*="/drivesharing/"]',
  dialog: /^Share /,
  addPeople: /^Add people/,
  peopleList: /^List of people/,
  generalAccess: /change general access$/,
  linkRole: /change link permission$/,
  personRole: /change permission$|Change access$/i,
  notify: /^Notify people/,
  message: /^Message$/,
  send: /^(Send|Share)$/,
  cancel: /^Cancel$/,
  done: /^Done$/,
  save: /^Save$/,
  removeAccess: /^Remove access/,
  access: {
    restricted: /^Restricted$/,
    anyone: /^Anyone with the link$/,
  },
  roles: {
    reader: /^Viewer$/,
    commenter: /^Commenter$/,
    writer: /^Editor$/,
  },
} as const;

export const FILE_DIALOG_LABELS = {
  copyDialog: /^Copy document$/,
  copyName: /^Name/,
  copyShareSamePeople: /^Share it with the same people$/,
  copyComments: /^Copy comments$/,
  makeCopy: /^Make a copy$/,
  pickerFrame: 'iframe[src*="/picker/"]',
  pickerSearch: /^Search$/,
  pickerMove: /^Move$/,
  pickerAllLocations: /^All locations$/,
  pickerMyDrive: /^My Drive$/,
  exportComplete: /^Export complete$/,
  exportOpen: /^Open now$/,
  nameVersionDialog: /^Name current version$/,
} as const;
