const FTPClient = require('ftp');
const Log = require('logger');
var NodeHelper = require('node_helper');
const ConcatStream = require('concat-stream');
const { Base64Encode } = require('base64-stream');
const { ExtensionAuthorized, MimeTypesAuthorized } = require('./src/constants/img-authorized');

module.exports = NodeHelper.create({
	dirIndex: 0,
	dirPathVisited: [], // Array<string>
	dirNameList: [], // Array<{ id: number; name: string }>

	imgNameList: [], // Array<{ id: number; name: string }>
	imgBase64: new Object(), // { base64: string; mimeType: string }

	init: function () {
		Log.log('MMM-FTP-image module helper initialized.');
	},

	socketNotificationReceived: function (notification, payload) {
		switch (notification) {
			case 'FTP_IMG_CALL_LIST':
				this.imgNameList = [];

				if (payload.dirPathsAuthorized) {
					this.dirPathsAuthorized = payload.dirPathsAuthorized;
					this.connectFTPServer('list', payload);
				} else {
					Log.error('dirPathsAuthorized is not defined !');
				}
				break;
			case 'FTP_IMG_CALL_BASE64':
				this.imgBase64 = new Object();
				this.connectFTPServer('get', payload);
				break;
			case 'FTP_IMG_CALL_NEXT_DIR':
				this.dirIndex++;
				break;
		}
	},

	connectFTPServer: function (type, payload) {
		const ftp = new FTPClient();
		const self = this;

		ftp.on('ready', function () {
			switch (type) {
				case 'list':
					self.dirChangeAlgo(ftp, self, payload, type);
					self.sendListName(ftp, self);
					break;
				case 'get':
					self.dirChangeAlgo(ftp, self, payload, type);
					self.sendBase64Img(ftp, self, payload);
					break;
				default:
					throw new Error(`This type is not implemented => ${type}`);
			}
		});

		ftp.connect({
			...payload,
		});
	},

	dirChangeAlgo: function (ftp, self, payload, type) {
		let path = null;

		if (self.dirIndex > 0) {
			path = payload.defaultDirPath
				? `${payload.defaultDirPath}/${self.dirNameList[self.dirIndex - 1].name}`
				: self.dirNameList[self.dirIndex - 1].name;

			if (type === 'list') {
				self.dirPathVisited.push(self.dirNameList[self.dirIndex - 1].name);
			}

			if (
				self.dirPathVisited.length === self.dirNameList.length &&
				type === 'get' &&
				payload.finishAllImgInCurrentDirectory
			) {
				self.dirIndex = -1;
				self.dirPathVisited = [];
			}
		}
		// First call and defaultDirPath is defined
		else if (payload.defaultDirPath && !payload.finishAllImgInCurrentDirectory) {
			path = payload.defaultDirPath;
		}
		// End all directory has been visited and defaultDirPath is defined => restart
		else if (payload.defaultDirPath && payload.finishAllImgInCurrentDirectory) {
			self.dirIndex = 0;
			self.dirPathVisited = [];
			path = payload.defaultDirPath;
		}

		if (path) {
			self.moveDir(ftp, path);
		}
	},

	moveDir: function (ftp, path) {
		ftp.cwd(path, function (err) {
			if (err) {
				console.warn('Error while moving to directory', err);
				self.reset();
				throw err;
			}
		});
	},

	sendListName: function (ftp, self) {
		ftp.list(async function (err, list) {
			if (err) {
				console.warn('Error while listing files', err);
				self.reset();
				throw err;
			}

			for (let i = 0; i < list.length; i++) {
				const file = list[i];

				switch (file.type) {
					case '-': // File type
						if (file.name.match(new RegExp(`.(${ExtensionAuthorized}?)$`, 'gm'))) {
							self.imgNameList.push({
								name: file.name,
								id: self.imgNameList.length + 1,
							});
						}
						break;

					case 'd': // Directory type
						if (
							(!['.', '..'].includes(file.name) &&
								(!self.dirPathsAuthorized || self.dirPathsAuthorized.length === 0)) ||
							(!['.', '..'].includes(file.name) &&
								self.dirPathsAuthorized &&
								self.dirPathsAuthorized.includes(file.name))
						) {
							self.dirNameList.push({
								name: file.name,
								id: self.dirNameList.length + 1,
							});
						}
						break;
				}
			}

			ftp.end();

			self.sendSocketNotification('FTP_IMG_LIST_NAME', self.imgNameList);
		});
	},

	sendBase64Img: async function (ftp, self, payload) {
		await new Promise((resolve, reject) => {
			ftp.get(payload.fileName, function (err, stream) {
				if (err) {
					console.warn('Error while getting file', err);
					reject(err);

					self.reset();
				}

				self.streamToBase64(stream, ftp)
					.then(function (res) {
						self.imgBase64 = {
							base64: res,
							mimeType: self.getMimeType(payload.fileName),
						};
						resolve();
					})
					.catch(function (err) {
						console.warn('Error while converting stream to base64', err);
						self.reset();
						throw new Error(err);
					});
			});
		});

		self.sendSocketNotification('FTP_IMG_BASE64', self.imgBase64);
	},

	streamToBase64: function (stream, ftp) {
		return new Promise((resolve, reject) => {
			const base64 = new Base64Encode();

			const cbConcat = base64 => {
				resolve(base64);
			};

			stream
				.pipe(base64)
				.pipe(ConcatStream(cbConcat))
				.once('close', function () {
					ftp.end();
				})
				.on('error', error => {
					console.warn('Error while piping stream', error);
					reject(error);
					self.reset();
				});
		});
	},

	getMimeType: function (filename) {
		for (const s in MimeTypesAuthorized) {
			if (filename.indexOf(s) === 0) {
				return MimeTypesAuthorized[s];
			}
		}
	},

	reset: function () {
		this.dirIndex = 0;
		this.dirPathVisited = [];
		this.dirNameList = [];
		this.imgNameList = [];
		this.imgBase64 = new Object();

		this.sendSocketNotification('RESET');
	},
});
