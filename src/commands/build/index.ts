
import { Args, Command, Flags } from '@oclif/core'
import { exit, test, touch, exec, ShellString, ExecOptions, echo } from 'shelljs'

import * as TOML from '@iarna/toml'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { AstBuilder, GherkinClassicTokenMatcher, Parser, compile } from '@cucumber/gherkin'
import { IdGenerator } from '@cucumber/messages'
import { Configuration, OpenAIApi } from 'openai'
import { stderr } from 'process'
import { createHash } from 'node:crypto'

//let chats = []
export default class Build extends Command {
    static flags = {
        config: Flags.string({ char: 'c', description: 'toml config file', required: false, default: './codellms.toml' }),
        features: Flags.string({ char: 'f', description: 'features dir', required: false, default: './features/' }),
    }
    chats: Array<any> = []
    openai!: OpenAIApi
    openaiConfig: { [key: string]: any } = {}
    async run(): Promise<void> {
        const { flags } = await this.parse(Build)
        const configFile = fs.readFileSync(flags.config, 'utf-8')
        const config = JSON.parse(JSON.stringify(TOML.parse(configFile)))
        this.log('go go go')
        const apiKey = config['openai']?.['api_key'] || process.env['openai_api_key']
        if (!apiKey) {
            this.error('must provide openai api key')
            return;
        }
        const configuration = new Configuration({
            apiKey
        });
        this.openaiConfig['model'] = config['openai']?.['model'] || 'gpt-3.5-turbo'
        this.openaiConfig['temperature'] = config['openai']?.['temperature'] || '0.4'
        this.openai = new OpenAIApi(configuration);
        this.chats.push(this.buildFirstChat(config))
        //if the lock file does not exist
        if (!test('-f', './codellms-lock.json')) {
            await this.initProject()
        }
        await this.parseFeatures(flags.features)//create code with features
        await this.createMainfile()
        await this.installDependencies()
        await this.tryBuildOrStart(config['basic']?.['debug_retry'])// debug with unitest,build...
    }

    buildFirstChat(config: any) {
        let osPlatform: string = os.platform()
        let osVersion: string = os.release()
        if (osPlatform == 'darwin') {
            osVersion = exec('sw_vers -productVersion').stdout
            osPlatform = 'macOS'
        }
        return {
            "role": "system", "content": `You are ChatGPT, a large language model trained by OpenAI.I hope you can act as a coding expert and use ${config['basic']['language']} to develop using the following framework or library: ${JSON.stringify(config['dependencies'])}, and use ${config['basic']['arch']} pattern for project architecture.
You need to return in the format I requested, without any other content. No explanation or other non-code replies are required.
For example, when I ask you to return an array, In the following format:
[[code]]
insert array here
[[/code]]
,you only need to reply with an array, such as returning this content directly:
[[code]]
["a", "b", "c"]
[[/code]]
.
The format below is incorrect:
\`\`\`javascript
["a", "b", "c"]
\`\`\`
.Current OS is ${osPlatform}, os version is ${osVersion}`
        }
    }
    getBlockContent(strInput: string, blockName: string): string {
        //const regxStr = `(?<=\[\[${blockName}\]\]\n)([\s\S]*?)(?=\n\[\[\/${blockName}\]\]$)`;
        const regxStr = `(?<=\\[\\[${blockName}\\]\\]\\n)([\\s\\S]*?)(?=\\n\\[\\[\\/${blockName}\\]\\]$)`;

        const regx = new RegExp(regxStr, 'sm')
        //if(regx.test(strInput)){
        let content = regx.exec(strInput)?.[1] || undefined
        return content || strInput
        //}
        //return strInput
    }
    async askgpt(question: Array<any>): Promise<string | undefined> {
        const response = await this.openai.createChatCompletion({
            model: this.openaiConfig['model'],
            messages: question,
            temperature: this.openaiConfig['temperature']
        })
        this.log('chatgpt response:')
        const result = response.data.choices?.[0]
        const answerResult: string | undefined = result?.message?.content
        if (result?.finish_reason === 'stop' || result?.finish_reason === 'content_filter') {
            this.chats.push({ "role": result?.message?.role, "content": answerResult })
        } else {
            this.log('gpt need continue')
            //this.chats.push({ "role": "user", "content": "continue"})
            //this.askgpt(this.chats)// continue
        }
        this.log(answerResult)
        return answerResult
    }

    // if the codellms.lock does not exist.
    async initProject(): Promise<void> {
        // init project
        const chat = { "role": "user", "content": `Please tell me what command to use to initialize this project in the current directory. Reply with the executable command that contains "yes" to automatically confirm execution without any user interaction. Please do not include any further explanation in your response.
        For example:
        echo y | npm init -y && npm install express --save && npm install -g nodemon
        Or:
        npm init -y && npm install express --save  && npm install -g nodemon` }
        this.chats.push(chat)
        let initCommandAnswer = await this.askgpt(this.chats)
        initCommandAnswer = this.cleanCodeBlock(initCommandAnswer!) as string
        await this.execCommand(initCommandAnswer)
        touch('codellms-lock.json')
        // init folder
        this.chats.push({
            "role": "user", "content": `Please tell me which folders need to be created, and return them in an array. Multi-level directories can be represented directly as "a/b/c". For example:
[[code]]
"src/xxx/yyy/zzz",
"src/abc"
[[/code]]
.
` })
        let folderAnswer: string = await this.askgpt(this.chats) as string
        folderAnswer = this.getBlockContent(folderAnswer, 'code')
        this.log('init folders:', folderAnswer)
        Array.from(JSON.parse(folderAnswer!)).forEach(f => {
            const fd = f as fs.PathLike
            this.createFolder(fd)
        })// init folder

    }

    createFolder(folder: fs.PathLike): void {

        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true })
        }
    }

    createFile(file: string, content: string | NodeJS.ArrayBufferView) {
        let fileStr = file?.replaceAll("\"", "").replaceAll("\'", "")
        if (fileStr.indexOf('/') > -1) {
            let folderArr = fileStr.split('/')
            folderArr.pop()// remove file name and ext
            this.createFolder(folderArr.join('/') as fs.PathLike)
        }
        this.log('create file:', fileStr)
        fs.writeFileSync(fileStr as fs.PathOrFileDescriptor, content)
    }
    execCommand(command: string | undefined, cb?: { onSuccess?: Function, onError?: Function }): Promise<String> {
        if (command && command.trim()) {
            const { onSuccess, onError } = cb || {}
            //let maybeDoExit = setTimeout(() => exit(1), 10000)// If the following commands are not automatically terminated
            const execResult = new Promise<string>((resolve, reject)=>{
                const process = exec(command.trim(), (code, stdout, stderr) => {
                    if (code !== 0) {
                        echo(`Error: exec command fail,command is: ${command}`)
                        if (onError) {
                            onError(stderr)
                        }
                        reject(stderr)
                        
                    } else {
                        this.log(`command: '${command}'executed successfully`)
                        if (onSuccess) {
                            onSuccess(stdout)
                        }
                        resolve(stdout)
                    }
                
                })
                process?.stdin?.on('data', (input) => {
                    process?.stdin?.write(input)
                })
            })
            return execResult
        }
        throw new Error('command is empty')
    }
    // add and install dependencies to project.
    async installDependencies(): Promise<void> {
        const chat = { "role": "user", "content": "Based on the code you provided, please tell me the command to add dependencies and which dependencies are needed. Please provide the command directly without explanation. Here is an example of what should be returned: npm install express uuid --save." }
        this.chats.push(chat)
        const answer = await this.askgpt(this.chats)
        await this.execCommand(answer)
    }
    // remove ````
    cleanCodeBlock(codeContent: string | NodeJS.ArrayBufferView): string | NodeJS.ArrayBufferView {
        let hasBlock = (codeContent as string)?.trim().startsWith("```")
        let codeBody = codeContent
        if (hasBlock) {
            let lines = (codeContent as string).split('\n')
            lines.shift()
            lines.pop()
            codeBody = lines.join('\n')
        }
        return codeBody
    }
    getLockFile(): { [key: string]: any } {
        const codellmsLockFile = fs.readFileSync('codellms-lock.json')
        let lockFeatureJson: { [key: string]: any } = {};
        if (!!codellmsLockFile.toString()?.trim()) {
            lockFeatureJson = JSON.parse(codellmsLockFile.toString())
        }
        return lockFeatureJson
    }
    async createMainfile() {
        let lockFeatureJson: { [key: string]: any } = this.getLockFile();

        let chat = {
            "role": "user", "content": `Please tell me the code content of the project's entry file and its file path. Without any explanatory or descriptive text. Here is an example of what should be returned:
[[file]]
put the file path here
[[/file]]
[[code]]
insert code here
[[/code]]
`}
        const mainFilePath: string | undefined = lockFeatureJson['main']?.['path']
        if (mainFilePath) {
            let mainFileContent = fs.readFileSync(mainFilePath)?.toString()
            chat = {
                "role": "user",
                "content": `
The code for my entry file is as follows:
[[code]]
${mainFileContent}
[[/code]]
, please determine based on our previous conversation whether this file needs to be modified.
If modification is required, please return in the following format:
[[code]]
insert code here(If no modification is necessary or if there is insufficient information to make a determination, simply return null here.)
[[code]]
. If no modification is necessary or if there is insufficient information to make a determination, simply return null in this [[code]] block, For example:
[[code]]
null
[[/code]]
`
            }
        }
        this.chats.push(chat)
        const answer = await this.askgpt(this.chats) as string
        const filePath = mainFilePath || this.getBlockContent(answer, 'file')
        const codeBody = this.getBlockContent(answer, 'code')
        if (filePath && !!codeBody && codeBody !== "null") {
            this.createFile(filePath!, codeBody!)

            const mainFileHash = createHash('sha512').update(codeBody, 'utf-8').digest('hex')
            lockFeatureJson['mainfile'] = {
                integrity: mainFileHash,
                path: filePath
            }
            this.createFile('codellms-lock.json', JSON.stringify(lockFeatureJson))
        }
    }
    // parse bdd feature file
    async parseFeatures(featuredir: fs.PathLike) {
        // 1.load file
        // 2. parse
        const uuid = IdGenerator.uuid()
        const builder = new AstBuilder(uuid)
        const matcher = new GherkinClassicTokenMatcher()
        const parser = new Parser(builder, matcher)

        const filenames = fs.readdirSync(featuredir).sort()
        // start read codellms lock file.
        let lockFeatureJson: { [key: string]: any } = this.getLockFile();

        // read codellms lock file end.
        let resetIndex = this.chats.length//
        for (let j = 0; j < filenames.length; j++) {
            if (resetIndex < this.chats.length - 1) {
                this.chats.splice(resetIndex, this.chats.length)
            }// Each feature context starts anew.
            const file = filenames[j]
            if (path.extname(file) === '.feature') {
                this.log('feature file:', file)
                const spec = fs.readFileSync(path.join(featuredir.toString(), file), 'utf-8')
                const specHash = createHash('sha512').update(spec, 'utf-8').digest('hex')
                // Determine whether the file has been modified
                const featureNodeInLock: { [key: string]: any } | undefined = lockFeatureJson['features']?.[file]
                if (featureNodeInLock !== undefined) {
                    if (featureNodeInLock['integrity'] === specHash) {
                        continue;
                    }
                }
                // todo: read the original code
                lockFeatureJson['features'] = lockFeatureJson['features'] || {}
                lockFeatureJson['features'][file] = {
                    integrity: specHash,
                    childrens: []// Code files generated by gpt
                }// init feature file node

                let projectFiles = { ...lockFeatureJson['features'] }
                for (const k in projectFiles) {
                    delete projectFiles[k]['integrity']
                }
                this.log('project files: ', projectFiles)
                const chat = {
                    "role": "user", "content": `Based on the provided BDD-like requirement and the existing project files, please generate a list of file paths that need to be updated or created to implement the required features. When updating existing files, make sure to preserve and extend the existing functionality. Sort the array according to the call tree relationship, with the files being called listed first, and use double quotes for array items of character type. Exclude notes and punctuation other than the array object.
The BDD-like requirement content is as follows: \`\`\`${spec.toString()} \`\`\`.
The existing project files and their paths are listed here: \`\`\`${projectFiles}\`\`\`.
Please consider the current project structure and functionalities, reuse existing files whenever possible, and follow the current file structure. Now let's analyze the requirement and project files step by step.` }
                this.chats.push(chat)
                let answer = await this.askgpt(this.chats) as string
                answer = this.getBlockContent(answer, 'code') as string
                const codeFiels = Array.from(JSON.parse(answer))
                // todo: delete integrity
                for (let i = 0; i < codeFiels.length; i++) {
                    const f = codeFiels[i] as string
                    this.log('code file:', f)
                    let oldCode: string | undefined
                    let modifyCodePrompt: string = ''
                    const childrenFiles: Array<string> | undefined = projectFiles?.[file]?.['childrens']
                    if (childrenFiles !== undefined && childrenFiles?.findIndex(x => x == f) > -1) {
                        // get old code file
                        oldCode = fs.readFileSync(f, 'utf-8')
                        modifyCodePrompt = `The code file(${f}) provided currently exists, therefore, the existing code is provided below:
[[code]]
${oldCode}
[[/code]]
.Please modify the following code based on the new requirements. The modified code should:
1.Keep the code of the existing feature.
2.Add/modify the code only for new/changed requirements.
3.The final code should be complete and runnable.
`
                    }
                    lockFeatureJson['features'][file]['childrens'].push(f)
                    this.chats.push({
                        "role": "user", "content": `${modifyCodePrompt}
Please provide the final code of the ${f} in the following format:
[[code]]
final code here
[[/code]]
.Let's think step by step and provide clean, maintainable and accurate code with comments for each method.`})
                    const codeContent = await this.askgpt(this.chats) as string
                    //let codeBody = this.cleanCodeBlock(codeContent)
                    let codeBody = this.getBlockContent(codeContent, 'code')
                    codeBody = this.cleanCodeBlock(codeBody) as string
                    //const filePath = f as fs.PathOrFileDescriptor
                    this.createFile(f, codeBody!)
                }
            }
        }
        this.createFile('codellms-lock.json', JSON.stringify(lockFeatureJson))
        // build project , tell project index to gpt if has error
    }

    async tryBuildOrStart(debugRetry: number): Promise<void> {
        // todo: If it's a scripting language use unit tests instead of running the project.
        const ask = { "role": "user", "content": "Please tell me the startup (scripting language) or build (compiled language) command for this project. so that I can run it in the current directory to get a preliminary idea of whether there are any errors .This command hopes that the console will not output warning, and the information you reply will only be executable commands, without any other information. For example, return it like this: RUSTFLAGS=-Awarnings cargo build." }
        this.chats.push(ask)
        let answer = await this.askgpt(this.chats)
        this.log('build command:', answer)
        let retry = 0
        const retryAsk = async (err: string) => {
            if (retry > debugRetry)
                return
            retry += 1;
            // ask gpt
            this.chats.push({
                "role": "user", "content": `During program execution, the following error occurred: '${err}' .Please think step by step about how to correct it and return the entire modified file code to me. If there are multiple files to modify, only return the first file.No need to explain the modification, just provide me with the correct code.For example:
[[file]]
insert file path here
[[/file]]
[[code]]
insert code here
[[/code]]
`})
            let tryCorretCode = await this.askgpt(this.chats) as string
            let filePath = this.getBlockContent(tryCorretCode, 'file')
            let maybeCorretCode = this.getBlockContent(tryCorretCode, 'code') as string
            //tryCorretCode = this.cleanCodeBlock(tryCorretCode) as string
            if (filePath) {
                this.createFile(filePath!, maybeCorretCode!)
            }
            await this.execCommand(answer).then(() => exit(1)).catch(retryAsk)

        }
        await this.execCommand(answer).then(() => exit(1)).catch(retryAsk)
    }
}
