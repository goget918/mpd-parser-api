
const url = require('url');
const path = require('path');

const PlayerConfiguration = require('../util/player_configuration');
const DashMpdParser = require('../dash_parser');
const { parse } = require('path');
const logger = require('../util/logger');

const ParserBrasiltecpar = async (req, res) => {
    const payload = req.body;
    const mpdUrl = payload.url;
    const videoRepId = payload.video.representation_id;
    const audioRepId = payload.audio.representation_id;
    const requestHeader = payload.headers;
    const numSegments = payload.numSegments;

    const parsedUrl = new url.URL(mpdUrl);
    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.pathname}`

    const config = PlayerConfiguration.createDefault().manifest;
    mpdParser = new DashMpdParser();
    mpdParser.configure(config);

    logger.info(`Parsing mpd ${mpdUrl} with rep id ${videoRepId}, ${audioRepId}`);
    await mpdParser.start(mpdUrl, baseUrl, requestHeader);

    const parsedResult = mpdParser.manifest_;

    if (!parsedResult) {
        return res.json({});
    }

    let targetStream = null;

    for (const variant of parsedResult.variants) {
        if (variant.audio.originalId == audioRepId &&
            variant.video.originalId == videoRepId) {
            targetStream = variant;
            break;
        }
    }

    if (!targetStream) {
        return res.json({});
    }

    const audio = targetStream.audio;
    const video = targetStream.video;

    await audio.createSegmentIndex();
    await video.createSegmentIndex();

    const responseData = {};
    const videoData = [];
    const videoInitSegmentIndex = video.segmentIndex.indexes_[0].initSegmentReference_;
    const videoSegmentIndex = video.segmentIndex;
    const videototalNum = videoSegmentIndex.indexes_[0].getNumReferences();

    const audioData = [];
    const audioInitSegmentIndex = audio.segmentIndex.indexes_[0].initSegmentReference_;
    const audioSegmentIndex = audio.segmentIndex;
    const audiototalNum = audioSegmentIndex.indexes_[0].getNumReferences();

    // Get init segment information
    videoData.push({
        segment: 0,
        type: "initialization",
        uri: videoInitSegmentIndex.getUris()[0]
    });

    audioData.push({
        segment: 0,
        type: "initialization",
        uri: audioInitSegmentIndex.getUris()[0]
    });

    // get lateseet segments
    let i = 1;
    const audioIndexList = [];
    const videoIndexList = [];

    let videoSegmentOffset = -1;
    let audioSegmentOffset = -1;

    while (true) {
        const videoUri = videoSegmentIndex.get(videototalNum - i).getUrisInner();
        const videoSegmentNum = path.basename(videoUri[0], path.extname(videoUri[0]));
        const digitedIndex = videoSegmentNum.replace(/\D/g, '');
        videoIndexList.push(digitedIndex);
        const sameAudioFoundIdx = audioIndexList.indexOf(digitedIndex);
        if (sameAudioFoundIdx != -1) {
            videoSegmentOffset = i - 1;
            logger.info(`video is ${i - 1} behind audio`);
            break;
        }

        const audioUri = audioSegmentIndex.get(audiototalNum - i).getUrisInner();
        const audioSegmentNum = path.basename(audioUri[0], path.extname(audioUri[0]));
        const audiodigitedIndex = audioSegmentNum.replace(/\D/g, '');
        audioIndexList.push(audiodigitedIndex);
        const sameVideoFoundIdx = videoIndexList.indexOf(audiodigitedIndex);
        if (sameVideoFoundIdx != -1) {
            logger.info(`audio is ${i - 1} behind video`);
            audioSegmentOffset = i - 1;
            break;
        }

        i++;
    }

    if (videoSegmentOffset == -1 && audioSegmentOffset == -1) {
        logger.error(`No matched segment found in video & audio stream`);
        return res.json({});
    }

    for (let i = numSegments; i > 0; i--) {
        let videoUri = [];
        let audioUri = [];
        let videoSegIdx = -1;
        let audioSegIdx = -1;

        if (videoSegmentOffset != -1) {
            videoUri = videoSegmentIndex.get(videototalNum - i - videoSegmentOffset).getUrisInner();
            const videoSegmentNum = path.basename(videoUri[0], path.extname(videoUri[0]));
            videoSegIdx = videoSegmentNum.replace(/\D/g, '');

            audioUri = audioSegmentIndex.get(audiototalNum - i).getUrisInner();
            const audioSegmentNum = path.basename(audioUri[0], path.extname(audioUri[0]));
            audioSegIdx = audioSegmentNum.replace(/\D/g, '');
        } else if (audioSegmentOffset != -1) {
            videoUri = videoSegmentIndex.get(videototalNum - i).getUrisInner();
            const videoSegmentNum = path.basename(videoUri[0], path.extname(videoUri[0]));
            videoSegIdx = videoSegmentNum.replace(/\D/g, '');

            audioUri = audioSegmentIndex.get(audiototalNum - i - audioSegmentOffset).getUrisInner();
            const audioSegmentNum = path.basename(audioUri[0], path.extname(audioUri[0]));
            audioSegIdx = audioSegmentNum.replace(/\D/g, '');
        }

        audioData.push({
            segment: parseInt(audioSegIdx),
            type: "media",
            uri: audioUri[0]
        });

        videoData.push({
            segment: parseInt(videoSegIdx),
            type: "media",
            uri: videoUri[0]
        });
    }

    responseData.video = videoData;
    responseData.audio = audioData;

    res.json(responseData);
};

module.exports = ParserBrasiltecpar;