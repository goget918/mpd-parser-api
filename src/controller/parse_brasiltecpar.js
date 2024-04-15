const url = require('url');
const path = require('path');

const PlayerConfiguration = require('../util/player_configuration');
const DashMpdParser = require('../dash_parser');
const logger = require('../util/logger');

const getSegmentTimelineListForDuration = (presentationStartTime, timeShiftBufferDepth, timeLineList, duration) => {
    let durationSum = 0;
    let segmentTimelineList = [];
    const timeShiftBufferDepthInSec = timeShiftBufferDepth / 1000;

    for (let i = timeLineList.length - 1; i >= 0; i--) {
        durationSum += timeLineList[i].end - timeLineList[i].start;
        const durationPerSegment = parseInt(timeLineList[i].end - timeLineList[i].start);

        segmentTimelineList.push({
            start: parseInt(presentationStartTime + timeLineList[i].start + timeShiftBufferDepthInSec),
            stop: parseInt(presentationStartTime + timeLineList[i].end + timeShiftBufferDepthInSec),
            duration: durationPerSegment
        });

        if (durationSum >= duration) {
            break;
        }
    }

    return segmentTimelineList;
};

const ParserBrasiltecpar = async (req, res) => {
    try {
        const {
            url: mpdUrl,
            video: { representation_id: videoRepId },
            audio: { representation_id: audioRepId },
            headers: requestHeader,
            numSegments,
            bufferLength: timeDuration
        } = req.body;
        
        const parsedUrl = new url.URL(mpdUrl);
        const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.pathname}`;

        const config = PlayerConfiguration.createDefault().manifest;
        const mpdParser = new DashMpdParser();
        mpdParser.configure(config);

        logger.info(`Parsing mpd ${mpdUrl} with rep id ${videoRepId}, ${audioRepId}`);
        await mpdParser.start(mpdUrl, baseUrl, requestHeader);

        const parsedResult = mpdParser.manifest_;
        const presentationStartTime = parsedResult.presentationTimeline.getPresentationStartTime();
        const timeShiftBufferDepth = parsedResult.presentationTimeline.segmentAvailabilityDuration_;

        if (!parsedResult) {
            return res.json({});
        }

        const targetStream = parsedResult.variants.find(variant => variant.audio.originalId === audioRepId && variant.video.originalId === videoRepId);

        if (!targetStream) {
            return res.json({});
        }

        const audio = targetStream.audio;
        const video = targetStream.video;

        await Promise.all([audio.createSegmentIndex(), video.createSegmentIndex()]);

        const responseData = {
            maxSegmentDuration: parsedResult.presentationTimeline.maxSegmentDuration_,
            timeShiftBufferDepth,
            video: [],
            audio: []
        };

        const processSegmentData = (segmentIndex, segmentTimelineList, mediaData) => {
            const uri = segmentIndex.get(0).initSegmentReference.getUris()[0];
                mediaData.push({
                    segment: 0,
                    type: "initialization",
                    uri
                });
            for (let i = segmentTimelineList.length; i > 0; i--) {
                const uri = segmentIndex.get(segmentIndex.indexes_[0].getNumReferences() - i).getUrisInner()[0];
                const segmentNum = parseInt(path.basename(uri, path.extname(uri)).replace(/\D/g, ''));

                mediaData.push({
                    segment: segmentTimelineList[i - 1].start,
                    type: "media",
                    start: segmentTimelineList[i - 1].start,
                    stop: segmentTimelineList[i - 1].stop,
                    duration: segmentTimelineList[i - 1].duration,
                    uri
                });
            }
        };

        const videoSegmentIndex = video.segmentIndex;
        const videoTimelines = videoSegmentIndex.indexes_[0].templateInfo_.timeline;
        const videoSegmentTimelineList = getSegmentTimelineListForDuration(presentationStartTime, timeShiftBufferDepth, videoTimelines, timeDuration);

        processSegmentData(videoSegmentIndex, videoSegmentTimelineList, responseData.video);

        const audioSegmentIndex = audio.segmentIndex;
        const audioTimelines = audioSegmentIndex.indexes_[0].templateInfo_.timeline;
        const audioSegmentTimelineList = getSegmentTimelineListForDuration(presentationStartTime, timeShiftBufferDepth, audioTimelines, timeDuration);

        processSegmentData(audioSegmentIndex, audioSegmentTimelineList, responseData.audio);

        logger.info(`returning ${responseData.video.length} video segments and ${responseData.audio.length} audio ones for latest ${timeDuration} seconds..`);

        res.json(responseData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

module.exports = ParserBrasiltecpar;
